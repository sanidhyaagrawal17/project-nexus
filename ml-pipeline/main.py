from __future__ import annotations

import json
import os
import sys
import warnings
from pathlib import Path
from typing import Any, Optional

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from xgboost import DMatrix

from feature_utils import align_features, clean_column_names, prepare_dataframe, save_json, to_numeric_frame

warnings.simplefilter(action='ignore', category=pd.errors.PerformanceWarning)

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_OUTPUT_PATH = BASE_DIR / 'nexus_alerts.json'
DEFAULT_ALERT_THRESHOLD = float(os.getenv('NEXUS_ALERT_THRESHOLD', '0.85'))
DEFAULT_CRITICAL_THRESHOLD = float(os.getenv('NEXUS_CRITICAL_THRESHOLD', '0.95'))

app = FastAPI(title='Project Nexus Inference Service')
MODEL_STATE: dict[str, Any] = {}


class PredictRequest(BaseModel):
    csv_path: str = Field(..., description='Path to the CSV file that should be scored.')
    output_path: Optional[str] = Field(default=None, description='Optional path for writing the JSON payload.')


class StreamEventBatchRequest(BaseModel):
    events: list[dict[str, Any]] = Field(..., min_length=1, description='Transaction events to aggregate and score.')
    output_path: Optional[str] = Field(default=None, description='Optional path for writing the JSON payload.')


def _load_models():
    model_dir = BASE_DIR / 'models'

    try:
        iso_forest = joblib.load(model_dir / 'nexus_iso_forest.pkl')
        raw_model = joblib.load(model_dir / 'nexus_xgboost.pkl')
    except FileNotFoundError as exc:
        raise FileNotFoundError('Model artifacts are missing from ml-pipeline/models.') from exc

    calibrated_model = raw_model
    calibrated_path = model_dir / 'nexus_calibrated_model.pkl'
    if calibrated_path.exists():
        try:
            calibrated_model = joblib.load(calibrated_path)
        except Exception:
            calibrated_model = raw_model

        standby_model = None
        standby_calibrated_model = None
        standby_thresholds = None

        standby_model_path = model_dir / 'nexus_xgboost_standby.pkl'
        if standby_model_path.exists():
            try:
                standby_model = joblib.load(standby_model_path)
            except Exception:
                standby_model = None

        standby_calibrated_path = model_dir / 'nexus_calibrated_model_standby.pkl'
        if standby_calibrated_path.exists():
            try:
                standby_calibrated_model = joblib.load(standby_calibrated_path)
            except Exception:
                standby_calibrated_model = None

        standby_thresholds_path = model_dir / 'nexus_thresholds_standby.pkl'
        if standby_thresholds_path.exists():
            try:
                standby_thresholds = joblib.load(standby_thresholds_path)
            except Exception:
                standby_thresholds = None

    try:
        feature_schema = joblib.load(model_dir / 'nexus_feature_schema.pkl')
    except FileNotFoundError:
        feature_schema = None

    try:
        thresholds = joblib.load(model_dir / 'nexus_thresholds.pkl')
    except FileNotFoundError:
        thresholds = {
            'alert_threshold': DEFAULT_ALERT_THRESHOLD,
            'critical_threshold': DEFAULT_CRITICAL_THRESHOLD,
        }

    try:
        anomaly_scaler = joblib.load(model_dir / 'nexus_anomaly_scaler.pkl')
    except FileNotFoundError:
        anomaly_scaler = None

    return {
        'iso_forest': iso_forest,
        'raw_model': raw_model,
        'calibrated_model': calibrated_model,
        'standby_model': standby_model,
        'standby_calibrated_model': standby_calibrated_model,
        'feature_schema': feature_schema,
        'thresholds': thresholds,
        'standby_thresholds': standby_thresholds,
        'anomaly_scaler': anomaly_scaler,
    }


def _ensure_model_state():
    if not MODEL_STATE:
        MODEL_STATE.update(_load_models())


def _resolve_input_path(csv_path: str) -> Path:
    candidate = Path(csv_path)
    if candidate.is_absolute():
        return candidate

    service_relative = (BASE_DIR / candidate).resolve()
    if service_relative.exists():
        return service_relative

    return (BASE_DIR / 'data' / candidate).resolve()


def _load_dataframe(input_csv: Path):
    try:
        return pd.read_csv(input_csv, low_memory=False)
    except Exception as exc:
        raise RuntimeError(f'Failed to read live data: {exc}') from exc


def _scale_anomaly_scores(scores, anomaly_scaler=None):
    scores = np.asarray(scores, dtype=float)
    if anomaly_scaler:
        min_score = float(anomaly_scaler.get('min', np.min(scores)))
        max_score = float(anomaly_scaler.get('max', np.max(scores)))
    else:
        min_score = float(np.min(scores))
        max_score = float(np.max(scores))
    if max_score <= min_score:
        return np.zeros(len(scores))
    return ((scores - min_score) / (max_score - min_score)) * 100


def _structured_top_features(feature_names, shap_row, feature_row, top_n=5):
    impacts = []
    for name, contribution, raw_value in zip(feature_names, shap_row, feature_row):
        numeric_raw = pd.to_numeric(pd.Series([raw_value]), errors='coerce').iloc[0]
        impacts.append({
            'name': name,
            'raw': float(round(float(numeric_raw) if pd.notna(numeric_raw) else 0.0, 4)),
            'contribution': float(round(contribution, 4)),
            'direction': 'UP' if contribution >= 0 else 'DOWN',
        })
    impacts.sort(key=lambda item: abs(item['contribution']), reverse=True)
    return impacts[:top_n]


def _score_model_payload(model, X_live, anomaly_scores, account_ids, feature_names, thresholds, total_scanned, source_label='primary'):
    predict_proba = model.predict_proba(X_live)[:, 1]
    alert_indices = np.flatnonzero(predict_proba >= thresholds['alert_threshold'])

    if len(alert_indices) > 0:
        print(f'[*] Generating SHAP local explainability matrices for {len(alert_indices)} {source_label} alert rows...')
        X_alert = X_live.iloc[alert_indices]
        try:
            shap_values = _compute_shap_values(model, X_alert)
        except Exception as exc:
            print(f'[!] {source_label.title()} SHAP explainability fallback engaged: {exc}')
            shap_values = np.zeros((len(X_alert), X_alert.shape[1]))
    else:
        print(f'[*] No {source_label} alerts met the threshold; skipping SHAP explainability pass.')
        shap_values = np.zeros((0, X_live.shape[1]))

    alerts = []
    critical_count = 0
    high_risk_count = 0

    for alert_position, index in enumerate(alert_indices):
        probability = predict_proba[index]
        risk_score = float(round(probability * 100, 2))
        anomaly_score = float(round(anomaly_scores[index], 1))
        status = 'Critical' if probability >= thresholds['critical_threshold'] else 'High Risk'
        if status == 'Critical':
            critical_count += 1
        else:
            high_risk_count += 1

        alerts.append({
            'accountId': str(account_ids[index]),
            'riskScore': risk_score,
            'anomalyScore': anomaly_score,
            'topFeatures': _structured_top_features(feature_names, shap_values[alert_position], X_live.iloc[index]),
            'rawTelemetry': X_live.iloc[index].to_dict(),
            'status': status,
        })

    critical_share = len(alerts) and (critical_count / len(alerts)) or 0
    return {
        'success': True,
        'totalScanned': int(total_scanned),
        'count': len(alerts),
        'thresholds': thresholds,
        'data': alerts,
        'guardrail': {
            'criticalShare': critical_share,
            'criticalCount': critical_count,
            'highRiskCount': high_risk_count,
        },
    }


def _extract_binary_shap_values(raw_values):
    values = raw_values.values if hasattr(raw_values, 'values') else raw_values
    if isinstance(values, list):
        values = values[1] if len(values) > 1 else values[0]
    values = np.asarray(values)
    if values.ndim == 3:
        values = values[:, :, 1] if values.shape[2] > 1 else values[:, :, 0]
    return values


def _compute_shap_values(model, frame):
    explain_frame = to_numeric_frame(frame)
    try:
        explainer = shap.TreeExplainer(model)
        shap_values = _extract_binary_shap_values(explainer.shap_values(explain_frame))
    except Exception as exc:
        print(f'[*] SHAP TreeExplainer parser skipped; using XGBoost native Tree SHAP contributions: {exc}')
        contributions = model.get_booster().predict(
            DMatrix(explain_frame, feature_names=list(explain_frame.columns)),
            pred_contribs=True,
        )
        contributions = np.asarray(contributions)
        if contributions.ndim == 3:
            contributions = contributions[:, 1, :] if contributions.shape[1] > 1 else contributions[:, 0, :]
        shap_values = contributions[:, :-1]
    if shap_values.shape != explain_frame.shape:
        raise ValueError(f'SHAP matrix shape {shap_values.shape} does not match feature matrix {explain_frame.shape}.')
    return shap_values


def _predict_from_dataframe(df: pd.DataFrame, output_path: str | Path | None = None, source_label: str = 'csv'):
    _ensure_model_state()

    print(f'\n=== Nexus {source_label.title()} Inference Engine ===')
    df_clean = clean_column_names(df)
    X_base, _, _ = prepare_dataframe(df_clean)

    account_ids = X_base.index.astype(str).tolist()
    feature_schema = MODEL_STATE['feature_schema']
    feature_columns = feature_schema[:-1] if feature_schema and feature_schema[-1] == 'Anomaly_Score' else feature_schema
    if feature_columns is None:
        feature_columns = list(X_base.columns)

    X_live = align_features(X_base, feature_columns)
    X_live = to_numeric_frame(X_live)

    raw_anomaly = MODEL_STATE['iso_forest'].decision_function(X_live)
    scaled_anomaly = _scale_anomaly_scores(raw_anomaly, MODEL_STATE['anomaly_scaler'])

    X_live['Anomaly_Score'] = scaled_anomaly
    X_live = align_features(X_live, feature_columns + ['Anomaly_Score'])
    X_live = to_numeric_frame(X_live)

    primary_payload = _score_model_payload(
        MODEL_STATE['calibrated_model'],
        X_live,
        scaled_anomaly,
        account_ids,
        X_live.columns,
        MODEL_STATE['thresholds'],
        len(df),
        'primary',
    )

    payload = primary_payload
    standby_model = MODEL_STATE.get('standby_calibrated_model') or MODEL_STATE.get('standby_model')
    standby_thresholds = MODEL_STATE.get('standby_thresholds') or MODEL_STATE['thresholds']

    max_critical_share = float(os.getenv('NEXUS_MAX_CRITICAL_SHARE', '0.25'))
    primary_critical_share = primary_payload['guardrail']['criticalShare']
    standby_payload = None

    if standby_model is not None and primary_critical_share > max_critical_share:
        standby_payload = _score_model_payload(
            standby_model,
            X_live,
            scaled_anomaly,
            account_ids,
            X_live.columns,
            standby_thresholds,
            len(df),
            'standby',
        )

        if standby_payload['guardrail']['criticalShare'] <= primary_critical_share:
            payload = standby_payload
            payload['deploymentMode'] = 'STANDBY'
            payload['guardrail'] = {
                **payload['guardrail'],
                'primaryCriticalShare': primary_critical_share,
                'standbyActivated': True,
            }
        else:
            payload = primary_payload
            payload['deploymentMode'] = 'PRIMARY'
            payload['guardrail'] = {
                **payload['guardrail'],
                'primaryCriticalShare': primary_critical_share,
                'standbyActivated': False,
                'standbyCriticalShare': standby_payload['guardrail']['criticalShare'],
            }
    else:
        payload['deploymentMode'] = 'PRIMARY'
        payload['guardrail'] = {
            **payload['guardrail'],
            'primaryCriticalShare': primary_critical_share,
            'standbyActivated': False,
        }

    resolved_output_path = Path(output_path) if output_path else DEFAULT_OUTPUT_PATH
    save_json(str(resolved_output_path), payload)
    return payload


def predict_from_csv_path(csv_path: str, output_path: str | Path | None = None):
    resolved_path = _resolve_input_path(csv_path)
    if not resolved_path.exists():
        raise FileNotFoundError(f'Input CSV not found: {resolved_path}')

    df = _load_dataframe(resolved_path)
    return _predict_from_dataframe(df, output_path=output_path, source_label='csv')


def predict_from_live_events(events, output_path: str | Path | None = None):
    df = pd.DataFrame(events)
    if df.empty:
        raise ValueError('Live stream batch did not contain any events.')

    return _predict_from_dataframe(df, output_path=output_path, source_label='live stream')


@app.on_event('startup')
def _startup():
    _ensure_model_state()


@app.get('/healthz')
def healthz():
    return {'ok': True, 'service': 'ml-pipeline'}


@app.post('/predict')
def predict(request: PredictRequest):
    try:
        return predict_from_csv_path(request.csv_path, request.output_path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post('/predict_stream_batch')
def predict_stream_batch(request: StreamEventBatchRequest):
    try:
        return predict_from_live_events(request.events, request.output_path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def main(argv=None):
    argv = argv or sys.argv
    input_file = argv[1] if len(argv) > 1 else 'data/demo_upload_data.csv'
    result = predict_from_csv_path(input_file)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
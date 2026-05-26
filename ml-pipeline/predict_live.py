import os
import sys
import warnings

import joblib
import numpy as np
import pandas as pd
import shap

from feature_utils import align_features, clean_column_names, prepare_dataframe, save_json, to_numeric_frame

warnings.simplefilter(action='ignore', category=pd.errors.PerformanceWarning)


def _load_models():
    try:
        iso_forest = joblib.load('models/nexus_iso_forest.pkl')
        raw_model = joblib.load('models/nexus_xgboost.pkl')
    except FileNotFoundError:
        print('[CRITICAL ERROR] Models not found.')
        sys.exit(1)

    calibrated_model = raw_model
    calibrated_path = 'models/nexus_calibrated_model.pkl'
    if os.path.exists(calibrated_path):
        try:
            calibrated_model = joblib.load(calibrated_path)
        except Exception:
            calibrated_model = raw_model

    try:
        feature_schema = joblib.load('models/nexus_feature_schema.pkl')
    except FileNotFoundError:
        feature_schema = None

    try:
        thresholds = joblib.load('models/nexus_thresholds.pkl')
    except FileNotFoundError:
        thresholds = {'alert_threshold': float(os.getenv('NEXUS_ALERT_THRESHOLD', '0.85')), 'critical_threshold': float(os.getenv('NEXUS_CRITICAL_THRESHOLD', '0.95'))}

    return iso_forest, raw_model, calibrated_model, feature_schema, thresholds


def _load_dataframe(input_csv):
    try:
        return pd.read_csv(input_csv, low_memory=False)
    except Exception as exc:
        print(f'[!] Failed to read live data: {exc}')
        sys.exit(1)


def _structured_top_features(feature_names, shap_row, feature_row, top_n=5):
    impacts = []
    for name, contribution, raw_value in zip(feature_names, shap_row, feature_row):
        impacts.append({
            'name': name,
            'raw': float(round(raw_value, 4)),
            'contribution': float(round(contribution, 4)),
            'direction': 'UP' if contribution >= 0 else 'DOWN',
        })
    impacts.sort(key=lambda item: abs(item['contribution']), reverse=True)
    return impacts[:top_n]


def export_alerts_to_json(X_live, predict_proba, scaled_anomaly, account_ids, output_path, total_scanned, shap_values, feature_names, thresholds):
    alerts = []
    alert_threshold = thresholds['alert_threshold']
    critical_threshold = thresholds['critical_threshold']

    for index, probability in enumerate(predict_proba):
        if probability >= alert_threshold:
            risk_score = float(round(probability * 100, 2))
            anomaly_score = float(round(scaled_anomaly[index], 1))
            status = 'Critical' if probability >= critical_threshold else 'High Risk'
            row_data = X_live.iloc[index].to_dict()

            alerts.append({
                'accountId': str(account_ids[index]),
                'riskScore': risk_score,
                'anomalyScore': anomaly_score,
                'topFeatures': _structured_top_features(feature_names, shap_values[index], X_live.iloc[index]),
                'rawTelemetry': row_data,
                'status': status,
            })

    save_json(output_path, {
        'success': True,
        'totalScanned': int(total_scanned),
        'count': len(alerts),
        'thresholds': thresholds,
        'data': alerts,
    })


def run_live_inference(input_csv):
    print('\n=== Nexus Live Inference Engine ===')
    output_json_path = 'nexus_alerts.json'

    iso_forest, raw_model, calibrated_model, feature_schema, thresholds = _load_models()
    df = _load_dataframe(input_csv)
    df_clean = clean_column_names(df)
    X_base, _, metadata = prepare_dataframe(df_clean)

    account_ids = X_base.index.astype(str).tolist()

    feature_columns = feature_schema[:-1] if feature_schema and feature_schema[-1] == 'Anomaly_Score' else feature_schema
    if feature_columns is None:
        feature_columns = list(X_base.columns)

    X_live = align_features(X_base, feature_columns)
    X_live = to_numeric_frame(X_live)
    raw_anomaly = iso_forest.decision_function(X_live)
    min_a, max_a = np.min(raw_anomaly), np.max(raw_anomaly)
    scaled_anomaly = ((raw_anomaly - min_a) / (max_a - min_a)) * 100 if max_a > min_a else np.zeros(len(raw_anomaly))

    X_live['Anomaly_Score'] = scaled_anomaly
    X_live = align_features(X_live, feature_columns + ['Anomaly_Score'])
    X_live = to_numeric_frame(X_live)

    predict_proba = calibrated_model.predict_proba(X_live)[:, 1]

    print('[*] Generating SHAP local explainability matrices...')
    try:
        explainer = shap.TreeExplainer(raw_model)
        shap_values = explainer.shap_values(X_live)
        if isinstance(shap_values, list):
            shap_values = shap_values[1]
    except Exception as exc:
        print(f'[!] SHAP explainability fallback engaged: {exc}')
        shap_values = np.zeros((len(X_live), X_live.shape[1]))

    export_alerts_to_json(
        X_live,
        predict_proba,
        scaled_anomaly,
        account_ids,
        output_json_path,
        len(df),
        shap_values,
        X_live.columns,
        thresholds,
    )


if __name__ == '__main__':
    input_file = sys.argv[1] if len(sys.argv) > 1 else 'data/demo_upload_data.csv'
    run_live_inference(input_file)
import os
import sys
import warnings

import joblib
import numpy as np
import pandas as pd
import shap
from imblearn.over_sampling import SMOTE
from sklearn.ensemble import IsolationForest
from sklearn.calibration import CalibratedClassifierCV
from sklearn.model_selection import train_test_split
from xgboost import DMatrix, XGBClassifier

from feature_utils import (
    clean_column_names,
    TARGET_COL,
    build_threshold_curve,
    compute_model_metrics,
    optimize_threshold,
    prune_correlated_features,
    prepare_dataframe,
    save_json,
    to_numeric_frame,
)


warnings.simplefilter(action='ignore', category=pd.errors.PerformanceWarning)


def _resolve_data_path(argv):
    data_path = os.getenv('NEXUS_DATA_PATH')
    if '--data-path' in argv:
        index = argv.index('--data-path')
        if index + 1 < len(argv):
            data_path = argv[index + 1]
    elif len(argv) > 1:
        data_path = argv[1]

    if not data_path:
        data_path = os.path.join('data', 'demo_upload_data.csv')
    return data_path


def _has_flag(argv, flag_name):
    return flag_name in argv


def _select_curve_probabilities(*candidate_sets):
    best_candidate = None
    best_score = None

    for candidate in candidate_sets:
        if candidate is None:
            continue

        values = np.asarray(candidate, dtype=float)
        values = values[np.isfinite(values)]
        if values.size == 0:
            continue

        score = (
            int(len(np.unique(np.round(values, 6)))),
            float(np.std(values)),
            float(np.ptp(values)),
        )
        if best_score is None or score > best_score:
            best_score = score
            best_candidate = values

    if best_candidate is None:
        return np.asarray([], dtype=float)

    return best_candidate


def _load_feedback_labels():
    try:
        from pymongo import MongoClient
    except Exception as exc:
        print(f"[!] Feedback retraining disabled: pymongo is unavailable ({exc}).")
        return {}

    mongo_uri = os.getenv('MONGO_URI') or os.getenv('MONGODB_URI') or 'mongodb://localhost:27017'
    try:
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=4000)
        db = client['nexusDB']
        collection_names = db.list_collection_names()
        preferred_names = ['AnalystFeedback', 'analystfeedbacks', 'analystfeedback']
        collection_name = next((name for name in preferred_names if name in collection_names), None)
        if collection_name is None:
            print('[*] No AnalystFeedback collection found in nexusDB; skipping feedback retraining.')
            return {}

        collection = db[collection_name]
        query = {'decision': {'$in': ['CONFIRMED_FRAUD', 'SAFE']}}
        projection = {'_id': 0, 'accountId': 1, 'Account_ID': 1, 'decision': 1}
        records = list(collection.find(query, projection))
    except Exception as exc:
        print(f"[!] Failed to load feedback labels from MongoDB: {exc}")
        return {}

    feedback_labels = {}
    for record in records:
        account_id = record.get('accountId', record.get('Account_ID'))
        decision = record.get('decision')
        if account_id is None or decision not in ('CONFIRMED_FRAUD', 'SAFE'):
            continue
        feedback_labels[str(account_id)] = 1 if decision == 'CONFIRMED_FRAUD' else 0

    print(f'[*] Loaded {len(feedback_labels)} verified analyst feedback labels from MongoDB.')
    return feedback_labels


def _merge_feedback_into_labels(X, y, feedback_labels):
    if not feedback_labels:
        return X, y, 0, 0

    y_series = y.copy() if y is not None else pd.Series(index=X.index, dtype='float64', name=TARGET_COL)
    original_positive = int((y_series == 1).sum()) if y_series.notna().any() else 0
    matched = 0
    for account_id, label in feedback_labels.items():
        if account_id in y_series.index:
            y_series.loc[account_id] = int(label)
            matched += 1

    if y is None:
        labeled_mask = y_series.notna()
        X = X.loc[labeled_mask].copy()
        y_series = y_series.loc[labeled_mask].astype(int)
    else:
        y_series = y_series.astype(int)

    updated_positive = int((y_series == 1).sum())
    return X, y_series, matched, max(updated_positive - original_positive, 0)


def _load_dataframe(data_path):
    try:
        return pd.read_csv(data_path, low_memory=False)
    except UnicodeDecodeError:
        return pd.read_csv(data_path, encoding='latin1', low_memory=False)


def _scale_anomaly_scores(scores, min_score=None, max_score=None):
    scores = np.asarray(scores, dtype=float)
    min_score = float(np.min(scores)) if min_score is None else float(min_score)
    max_score = float(np.max(scores)) if max_score is None else float(max_score)
    if max_score <= min_score:
        return np.zeros(len(scores)), {'min': min_score, 'max': max_score}
    scaled = ((scores - min_score) / (max_score - min_score)) * 100
    return scaled, {'min': min_score, 'max': max_score}


def _format_shap_alert_row(feature_names, shap_row, feature_row, top_n=5):
    impacts = []
    for name, contribution, raw_value in zip(feature_names, shap_row, feature_row):
        numeric_raw = pd.to_numeric(pd.Series([raw_value]), errors='coerce').iloc[0]
        safe_raw = float(numeric_raw) if pd.notna(numeric_raw) else 0.0
        contribution = float(contribution)
        impacts.append({
            'name': name,
            'raw': float(round(safe_raw, 4)),
            'contribution': float(round(contribution, 4)),
            'direction': 'UP' if contribution >= 0 else 'DOWN',
        })
    impacts.sort(key=lambda item: abs(item['contribution']), reverse=True)
    return impacts[:top_n]


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


def export_alerts_to_json(X_test, predict_proba, anomaly_scores, account_ids, output_path, shap_values, feature_names, thresholds, metrics, feature_importances):
    alerts = []
    alert_threshold = thresholds['alert_threshold']
    critical_threshold = thresholds['critical_threshold']

    for index, probability in enumerate(predict_proba):
        if probability >= alert_threshold:
            risk_score = float(round(probability * 100, 2))
            anomaly_score = float(round(anomaly_scores[index], 3))
            status = 'Critical' if probability >= critical_threshold else 'High Risk'

            top_features = _format_shap_alert_row(
                feature_names,
                shap_values[index],
                X_test.iloc[index],
                top_n=5,
            )

            alerts.append({
                'accountId': str(account_ids[index]),
                'riskScore': risk_score,
                'anomalyScore': anomaly_score,
                'topFeatures': top_features,
                'status': status,
            })

    alerts = sorted(alerts, key=lambda item: item['riskScore'], reverse=True)
    payload = {
        'success': True,
        'count': len(alerts),
        'thresholds': thresholds,
        'metrics': metrics,
        'featureImportance': feature_importances,
        'data': alerts,
    }
    save_json(output_path, payload)


def run_nexus_pipeline():
    print('=== Initializing Project Nexus Pipeline ===')

    data_path = _resolve_data_path(sys.argv)
    output_json_path = 'nexus_alerts.json'
    model_dir = 'models'
    output_dir = 'outputs'

    if not os.path.exists(data_path):
        print(f'[CRITICAL ERROR] Dataset not found at {data_path}.')
        sys.exit(1)

    print(f'[*] Loading dataset from {data_path}...')
    df = _load_dataframe(data_path)
    df_clean = clean_column_names(df)
    retrain_with_feedback = _has_flag(sys.argv, '--retrain-with-feedback')
    feedback_labels = _load_feedback_labels() if retrain_with_feedback else {}

    X, y, metadata = prepare_dataframe(df_clean)

    if y is None and not retrain_with_feedback:
        print(f"[CRITICAL ERROR] Target column '{TARGET_COL}' was not found or could not be cleaned.")
        sys.exit(1)

    if y is not None and (len(X) < 20 or y.nunique() < 2):
        print('[CRITICAL ERROR] Dataset does not contain enough signal for supervised training.')
        sys.exit(1)

    if retrain_with_feedback:
        X, y, matched_feedback, added_positive = _merge_feedback_into_labels(X, y, feedback_labels)
        print(f'[*] Feedback retraining merged {matched_feedback} labeled accounts into training data ({added_positive} newly positive labels).')
        if y is None or len(X) < 20 or y.nunique() < 2:
            print('[CRITICAL ERROR] Feedback retraining did not leave enough labeled signal for training.')
            sys.exit(1)

    print(f'[*] Prepared feature matrix: {X.shape[0]} rows x {X.shape[1]} columns.')
    print(f"[*] Target distribution:\n{y.value_counts(normalize=True) * 100}")
    print(f"[*] Input schema: {metadata.get('schema_type', 'unknown')}")
    if metadata.get('schema_type') == 'transaction_graph':
        graph_summary = metadata.get('graph_summary', {})
        print(f"[*] Graph summary: {graph_summary.get('node_count', 0)} nodes, {graph_summary.get('edge_count', 0)} edges.")

    X, dropped_features = prune_correlated_features(X)
    print(f'[*] Correlation pruning removed {len(dropped_features)} redundant features.')

    X_train_full, X_test, y_train_full, y_test = train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42,
        stratify=y,
    )
    X_train, X_calib, y_train, y_calib = train_test_split(
        X_train_full,
        y_train_full,
        test_size=0.2,
        random_state=42,
        stratify=y_train_full,
    )

    test_account_ids = X_test.index.astype(str).tolist()

    print('\n[*] Phase 1: Running Isolation Forest...')
    # Fix: use a contamination rate that matches the true fraud prevalence instead of over-flagging rows.
    iso_forest = IsolationForest(contamination=0.01, random_state=42)
    iso_forest.fit(X_train)

    train_anomaly_raw = iso_forest.decision_function(X_train)
    train_anomaly_scaled, anomaly_scaler = _scale_anomaly_scores(train_anomaly_raw)
    calib_anomaly_scaled, _ = _scale_anomaly_scores(
        iso_forest.decision_function(X_calib),
        anomaly_scaler['min'],
        anomaly_scaler['max'],
    )
    test_anomaly_raw = iso_forest.decision_function(X_test)
    test_anomaly_scaled, _ = _scale_anomaly_scores(
        test_anomaly_raw,
        anomaly_scaler['min'],
        anomaly_scaler['max'],
    )

    X_train_enhanced = X_train.copy()
    X_train_enhanced['Anomaly_Score'] = train_anomaly_scaled
    X_calib_enhanced = X_calib.copy()
    X_calib_enhanced['Anomaly_Score'] = calib_anomaly_scaled
    X_test_enhanced = X_test.copy()
    X_test_enhanced['Anomaly_Score'] = test_anomaly_scaled

    print('\n[*] Phase 2: Balancing training data via SMOTE...')
    smote = SMOTE(random_state=42)
    X_train_balanced, y_train_balanced = smote.fit_resample(X_train_enhanced, y_train)

    print('\n[*] Phase 3: Training XGBoost classifier...')
    xgb_model = XGBClassifier(
        n_estimators=240,
        max_depth=4,
        learning_rate=0.06,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=3,
        reg_lambda=10,
        n_jobs=-1,
        tree_method='hist',
        random_state=42,
        eval_metric='logloss',
    )
    xgb_model.fit(X_train_balanced, y_train_balanced)

    print('\n[*] Phase 3b: Training standby XGBoost classifier...')
    standby_xgb_model = XGBClassifier(
        n_estimators=320,
        max_depth=3,
        learning_rate=0.045,
        subsample=0.72,
        colsample_bytree=0.72,
        min_child_weight=5,
        reg_lambda=16,
        reg_alpha=0.3,
        n_jobs=-1,
        tree_method='hist',
        random_state=99,
        eval_metric='logloss',
    )
    standby_xgb_model.fit(X_train_balanced, y_train_balanced)

    calibrated_model = xgb_model
    standby_calibrated_model = standby_xgb_model
    calibration_available = False
    standby_calibration_available = False
    try:
        # Newer sklearn releases removed cv='prefit'; wrap the fitted model instead.
        if FrozenEstimator is not None:
            calibration_model = CalibratedClassifierCV(estimator=FrozenEstimator(xgb_model), method='isotonic', cv=3)
        else:
            calibration_model = CalibratedClassifierCV(estimator=xgb_model, method='isotonic', cv=3)
        calibration_model.fit(X_calib_enhanced, y_calib)
        calibrated_model = calibration_model
        calibration_available = True
    except Exception as exc:
        print(f'[!] Calibration skipped: {exc}')

    try:
        calibration_model = CalibratedClassifierCV(estimator=xgb_model, method='isotonic', cv='prefit')
        calibration_model.fit(X_calib_enhanced, y_calib)
        calibrated_model = calibration_model
        calibration_available = True
    except Exception as exc:
        print(f'[!] Calibration skipped: {exc}')
    except Exception as exc:
        print(f'[!] Standby calibration skipped: {exc}')

    # Fix: keep calibrated probabilities untouched so threshold tuning and metrics remain valid.
    validation_probabilities = calibrated_model.predict_proba(X_calib_enhanced)[:, 1]
    standby_validation_probabilities = standby_calibrated_model.predict_proba(X_calib_enhanced)[:, 1]
    raw_validation_probabilities = xgb_model.predict_proba(X_calib_enhanced)[:, 1]
    raw_standby_validation_probabilities = standby_xgb_model.predict_proba(X_calib_enhanced)[:, 1]

    curve_validation_probabilities = _select_curve_probabilities(
        validation_probabilities,
        raw_validation_probabilities,
    )
    curve_standby_probabilities = _select_curve_probabilities(
        standby_validation_probabilities,
        raw_standby_validation_probabilities,
    )

    threshold_settings = optimize_threshold(y_calib, validation_probabilities)
    standby_threshold_settings = optimize_threshold(y_calib, standby_validation_probabilities)
    threshold_curve = build_threshold_curve(y_calib, curve_validation_probabilities)
    standby_threshold_curve = build_threshold_curve(y_calib, curve_standby_probabilities)

    test_probabilities = calibrated_model.predict_proba(X_test_enhanced)[:, 1]
    standby_test_probabilities = standby_calibrated_model.predict_proba(X_test_enhanced)[:, 1]

    metrics = compute_model_metrics(y_test, test_probabilities, threshold_settings['alert_threshold'])
    metrics['calibration_used'] = calibration_available

    standby_metrics = compute_model_metrics(y_test, standby_test_probabilities, standby_threshold_settings['alert_threshold'])
    standby_metrics['calibration_used'] = standby_calibration_available

    feature_importances = pd.DataFrame(
        xgb_model.feature_importances_,
        index=X_train_enhanced.columns,
        columns=['importance'],
    ).sort_values('importance', ascending=False)

    feature_importance_payload = [
        {'name': index, 'importance': float(round(row.importance, 6))}
        for index, row in feature_importances.head(40).iterrows()
    ]

    print('\n=== Generating Nexus Threat Assessment ===')
    try:
        shap_values = _compute_shap_values(xgb_model, X_test_enhanced)
    except Exception as exc:
        print(f'[!] SHAP explainability fallback engaged: {exc}')
        shap_values = np.zeros((len(X_test_enhanced), X_test_enhanced.shape[1]))

    anomaly_scores = test_anomaly_scaled
    export_alerts_to_json(
        X_test_enhanced,
        test_probabilities,
        anomaly_scores,
        test_account_ids,
        output_json_path,
        shap_values,
        X_test_enhanced.columns,
        threshold_settings,
        metrics,
        feature_importance_payload,
    )

    os.makedirs(model_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    joblib.dump(iso_forest, os.path.join(model_dir, 'nexus_iso_forest.pkl'))
    joblib.dump(xgb_model, os.path.join(model_dir, 'nexus_xgboost.pkl'))
    joblib.dump(standby_xgb_model, os.path.join(model_dir, 'nexus_xgboost_standby.pkl'))
    joblib.dump(calibrated_model, os.path.join(model_dir, 'nexus_calibrated_model.pkl'))
    joblib.dump(standby_calibrated_model, os.path.join(model_dir, 'nexus_calibrated_model_standby.pkl'))
    joblib.dump(list(X_train_enhanced.columns), os.path.join(model_dir, 'nexus_feature_schema.pkl'))
    joblib.dump(threshold_settings, os.path.join(model_dir, 'nexus_thresholds.pkl'))
    joblib.dump(standby_threshold_settings, os.path.join(model_dir, 'nexus_thresholds_standby.pkl'))
    joblib.dump(anomaly_scaler, os.path.join(model_dir, 'nexus_anomaly_scaler.pkl'))

    save_json(os.path.join(output_dir, 'model_metrics.json'), {
        'inputSchema': {
            'type': metadata.get('schema_type', 'wide_table'),
            'entityIdColumn': metadata.get('entity_id_col', metadata.get('id_col')),
            'targetColumn': metadata.get('target_col'),
            'graphSourceColumn': metadata.get('graph_source_col'),
            'graphTargetColumn': metadata.get('graph_target_col'),
            'graphAmountColumn': metadata.get('graph_amount_col'),
            'graphTimestampColumn': metadata.get('graph_timestamp_col'),
        },
        'thresholds': threshold_settings,
        'metrics': metrics,
        'standbyThresholds': standby_threshold_settings,
        'standbyMetrics': standby_metrics,
        'featureImportance': feature_importance_payload,
        'highPriorityFeatures': metadata['high_priority_features'],
        'thresholdCurve': threshold_curve,
        'standbyThresholdCurve': standby_threshold_curve,
        'droppedFeatures': dropped_features,
        'featureCount': int(X.shape[1]),
        'engineeredFeatureCount': int(len(metadata['feature_columns']) - X.shape[1]),
        'evaluation': {
            'yTrue': [int(value) for value in y_test.tolist()],
            'yProbabilities': [float(value) for value in test_probabilities.tolist()],
        },
    })

    print('[*] Feature engineering, calibration, and evaluation artifacts saved.')
    print('=== Pipeline Execution Complete ===')


if __name__ == '__main__':
    run_nexus_pipeline()

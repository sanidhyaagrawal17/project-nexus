from __future__ import annotations

import argparse
import math
import os
import sys
from numbers import Real
from pathlib import Path

import joblib
from sklearn.metrics import average_precision_score, roc_auc_score


ROOT_DIR = Path(__file__).resolve().parent
MODEL_DIR = ROOT_DIR / 'models'
OUTPUT_DIR = ROOT_DIR / 'outputs'
DATA_DIR = ROOT_DIR / 'data'
METRICS_PATH = OUTPUT_DIR / 'model_metrics.json'
ALERTS_PATH = ROOT_DIR / 'nexus_alerts.json'


def _load_json(path: Path):
    if not path.exists():
        return None
    try:
        import json

        with path.open('r', encoding='utf-8') as handle:
            return json.load(handle)
    except Exception as exc:
        return {'__error__': str(exc)}


def _is_finite_number(value) -> bool:
    return isinstance(value, Real) and not isinstance(value, bool) and math.isfinite(float(value))


def _check_range(errors, label: str, value, low: float = 0.0, high: float = 1.0):
    if not _is_finite_number(value):
        errors.append(f'{label} must be a finite number, got {value!r}.')
        return
    numeric = float(value)
    if numeric < low or numeric > high:
        errors.append(f'{label} must be between {low} and {high}, got {numeric:.6f}.')


def _check_artifact_exists(errors, path: Path):
    if not path.exists():
        errors.append(f'Missing artifact: {path.name}')


def _check_database_wipe(errors, mongo_uri: str):
    try:
        from pymongo import MongoClient
    except Exception as exc:
        errors.append(f'Cannot verify database wipe because pymongo is unavailable: {exc}')
        return

    try:
        client = MongoClient(mongo_uri, serverSelectionTimeoutMS=4000)
        db = client['nexusDB']
        tracked_collections = ['Alert', 'ProcessedFile', 'ActivityLog', 'AnalystFeedback']
        for collection_name in tracked_collections:
            count = db[collection_name].count_documents({})
            if count != 0:
                errors.append(f'Database wipe failed: {collection_name} still has {count} documents.')

        leaked_csvs = sorted(DATA_DIR.glob('live_stream_*.csv'))
        if leaked_csvs:
            errors.append(
                'Database wipe cleanup failed: temporary CSVs still exist: '
                + ', '.join(file.name for file in leaked_csvs)
            )
    except Exception as exc:
        errors.append(f'Cannot verify database wipe: {exc}')


def _check_training_artifacts(errors):
    for artifact_name in [
        'nexus_iso_forest.pkl',
        'nexus_xgboost.pkl',
        'nexus_calibrated_model.pkl',
        'nexus_feature_schema.pkl',
        'nexus_thresholds.pkl',
    ]:
        _check_artifact_exists(errors, MODEL_DIR / artifact_name)

    _check_artifact_exists(errors, METRICS_PATH)

    if errors:
        return

    try:
        feature_schema = joblib.load(MODEL_DIR / 'nexus_feature_schema.pkl')
        thresholds_joblib = joblib.load(MODEL_DIR / 'nexus_thresholds.pkl')
    except Exception as exc:
        errors.append(f'Failed to load model artifacts: {exc}')
        return

    if not isinstance(feature_schema, list) or not feature_schema:
        errors.append('Feature schema must be a non-empty list.')
    elif not all(isinstance(item, str) and item.strip() for item in feature_schema):
        errors.append('Feature schema contains invalid column names.')

    metrics_bundle = _load_json(METRICS_PATH)
    if not isinstance(metrics_bundle, dict) or metrics_bundle.get('__error__'):
        errors.append(f'Failed to parse model_metrics.json: {metrics_bundle.get("__error__", "invalid JSON")}')
        return

    bundle_thresholds = metrics_bundle.get('thresholds') or {}
    bundle_metrics = metrics_bundle.get('metrics') or {}
    threshold_curve = metrics_bundle.get('thresholdCurve') or []
    feature_importance = metrics_bundle.get('featureImportance') or []
    evaluation = metrics_bundle.get('evaluation') or {}

    for label, key in [('alert_threshold', 'alert_threshold'), ('critical_threshold', 'critical_threshold')]:
        _check_range(errors, f'thresholds.{label}', bundle_thresholds.get(key))

    if _is_finite_number(bundle_thresholds.get('alert_threshold')) and _is_finite_number(bundle_thresholds.get('critical_threshold')):
        if float(bundle_thresholds['alert_threshold']) >= float(bundle_thresholds['critical_threshold']):
            errors.append('Alert threshold must be lower than critical threshold.')

    for metric_name in ['accuracy', 'precision', 'recall', 'f1', 'roc_auc', 'pr_auc']:
        _check_range(errors, f'metrics.{metric_name}', bundle_metrics.get(metric_name))

    sample_count = bundle_metrics.get('sample_count')
    alert_count = bundle_metrics.get('alert_count')
    confusion_matrix = bundle_metrics.get('confusion_matrix')

    if not isinstance(sample_count, int) or sample_count <= 0:
        errors.append(f'metrics.sample_count must be a positive integer, got {sample_count!r}.')

    if not isinstance(alert_count, int) or alert_count < 0:
        errors.append(f'metrics.alert_count must be a non-negative integer, got {alert_count!r}.')

    if isinstance(confusion_matrix, list) and len(confusion_matrix) == 2 and all(isinstance(row, list) and len(row) == 2 for row in confusion_matrix):
        total_confusion = sum(int(cell) for row in confusion_matrix for cell in row)
        if isinstance(sample_count, int) and total_confusion != sample_count:
            errors.append(
                f'Confusion matrix totals {total_confusion} rows, but sample_count is {sample_count}. '
                'The saved metrics are inconsistent.'
            )
    else:
        errors.append('metrics.confusion_matrix must be a 2x2 matrix.')

    if isinstance(alert_count, int) and isinstance(sample_count, int) and alert_count > sample_count:
        errors.append('Alert count cannot exceed sample count.')

    if not isinstance(threshold_curve, list) or not threshold_curve:
        errors.append('thresholdCurve must be a non-empty list.')
    else:
        previous_threshold = -1.0
        for index, point in enumerate(threshold_curve):
            if not isinstance(point, dict):
                errors.append(f'thresholdCurve[{index}] must be an object.')
                continue
            threshold = point.get('threshold')
            _check_range(errors, f'thresholdCurve[{index}].threshold', threshold)
            if _is_finite_number(threshold):
                threshold_value = float(threshold)
                if threshold_value < previous_threshold:
                    errors.append('thresholdCurve thresholds must be sorted in ascending order.')
                previous_threshold = threshold_value
            for metric_name in ['precision', 'recall', 'f1']:
                _check_range(errors, f'thresholdCurve[{index}].{metric_name}', point.get(metric_name))
            if not isinstance(point.get('alert_count'), int) or point.get('alert_count', 0) < 0:
                errors.append(f'thresholdCurve[{index}].alert_count must be a non-negative integer.')

    if not isinstance(feature_importance, list) or not feature_importance:
        errors.append('featureImportance must be a non-empty list.')
    else:
        previous_importance = None
        for index, item in enumerate(feature_importance):
            if not isinstance(item, dict):
                errors.append(f'featureImportance[{index}] must be an object.')
                continue
            if not isinstance(item.get('name'), str) or not item['name'].strip():
                errors.append(f'featureImportance[{index}].name must be a non-empty string.')
            importance = item.get('importance')
            if not _is_finite_number(importance):
                errors.append(f'featureImportance[{index}].importance must be numeric.')
                continue
            importance_value = float(importance)
            if importance_value < 0:
                errors.append(f'featureImportance[{index}].importance cannot be negative.')
            if previous_importance is not None and importance_value > previous_importance + 1e-12:
                errors.append('featureImportance must be sorted in descending order.')
            previous_importance = importance_value

    y_true = evaluation.get('yTrue') if isinstance(evaluation, dict) else None
    y_prob = evaluation.get('yProbabilities') if isinstance(evaluation, dict) else None
    if not isinstance(y_true, list) or not isinstance(y_prob, list) or not y_true or not y_prob:
        errors.append('metrics.evaluation must include non-empty yTrue and yProbabilities arrays.')
    elif len(y_true) != len(y_prob):
        errors.append('metrics.evaluation.yTrue and metrics.evaluation.yProbabilities must have the same length.')
    else:
        normalized_y_true = []
        normalized_y_prob = []
        for index, (label, probability) in enumerate(zip(y_true, y_prob)):
            if label not in (0, 1, 0.0, 1.0):
                errors.append(f'metrics.evaluation.yTrue[{index}] must be binary, got {label!r}.')
                continue
            if not _is_finite_number(probability):
                errors.append(f'metrics.evaluation.yProbabilities[{index}] must be numeric, got {probability!r}.')
                continue
            normalized_y_true.append(int(label))
            normalized_y_prob.append(float(probability))

        if normalized_y_true and normalized_y_prob and len(normalized_y_true) == len(normalized_y_prob):
            try:
                recomputed_roc_auc = float(roc_auc_score(normalized_y_true, normalized_y_prob))
                recomputed_pr_auc = float(average_precision_score(normalized_y_true, normalized_y_prob))
            except Exception as exc:
                errors.append(f'Failed to recompute ROC AUC / PR AUC: {exc}')
            else:
                _check_range(errors, 'metrics.roc_auc', bundle_metrics.get('roc_auc'))
                _check_range(errors, 'metrics.pr_auc', bundle_metrics.get('pr_auc'))

                stored_roc_auc = float(bundle_metrics.get('roc_auc', 0.0))
                stored_pr_auc = float(bundle_metrics.get('pr_auc', 0.0))
                if abs(stored_roc_auc - recomputed_roc_auc) > 0.01:
                    errors.append(
                        f'ROC AUC mismatch: stored {stored_roc_auc:.6f}, recomputed {recomputed_roc_auc:.6f}.'
                    )
                if abs(stored_pr_auc - recomputed_pr_auc) > 0.01:
                    errors.append(
                        f'PR AUC mismatch: stored {stored_pr_auc:.6f}, recomputed {recomputed_pr_auc:.6f}.'
                    )

    if isinstance(thresholds_joblib, dict):
        for key in ['alert_threshold', 'critical_threshold']:
            if key in thresholds_joblib and key in bundle_thresholds:
                if abs(float(thresholds_joblib[key]) - float(bundle_thresholds[key])) > 0.01:
                    errors.append(f'Threshold mismatch for {key} between model artifact and metrics JSON.')

    alert_export = _load_json(ALERTS_PATH)
    if isinstance(alert_export, dict) and alert_export.get('data'):
        alerts = alert_export['data']
        if not isinstance(alert_export.get('count'), int) or alert_export['count'] != len(alerts):
            errors.append('nexus_alerts.json count does not match the number of alert records.')

        zero_contribution_total = 0
        nonzero_contribution_total = 0
        for index, alert in enumerate(alerts):
            if not isinstance(alert, dict):
                errors.append(f'nexus_alerts.json data[{index}] must be an object.')
                continue
            if not _is_finite_number(alert.get('riskScore')):
                errors.append(f'Alert {index} riskScore must be numeric.')
            elif not 0 <= float(alert['riskScore']) <= 100:
                errors.append(f'Alert {index} riskScore must be between 0 and 100.')

            if not _is_finite_number(alert.get('anomalyScore')):
                errors.append(f'Alert {index} anomalyScore must be numeric.')

            top_features = alert.get('topFeatures')
            if not isinstance(top_features, list) or not top_features:
                errors.append(f'Alert {index} topFeatures must be a non-empty list.')
                continue

            for feature_index, feature in enumerate(top_features):
                if not isinstance(feature, dict):
                    errors.append(f'Alert {index} topFeatures[{feature_index}] must be an object.')
                    continue
                contribution = feature.get('contribution')
                if not _is_finite_number(contribution):
                    errors.append(f'Alert {index} topFeatures[{feature_index}].contribution must be numeric.')
                    continue
                if float(contribution) == 0.0:
                    zero_contribution_total += 1
                else:
                    nonzero_contribution_total += 1

        if zero_contribution_total > 0 and nonzero_contribution_total == 0:
            errors.append(
                'SHAP export is degenerate: every exported topFeatures contribution is 0.0. '
                'The model explanation path is not producing usable math.'
            )


def main(argv=None):
    parser = argparse.ArgumentParser(description='Verify Nexus model math, training artifacts, and optional wipe state.')
    parser.add_argument(
        '--stage',
        choices=['train', 'wipe'],
        default='train',
        help='Use train to verify model artifacts and math, or wipe to verify the database reset state.',
    )
    parser.add_argument(
        '--mongo-uri',
        default=os.getenv('MONGO_URI') or os.getenv('MONGODB_URI') or 'mongodb://127.0.0.1:27017',
        help='MongoDB connection string used for the wipe check.',
    )

    args = parser.parse_args(argv)

    errors = []

    if args.stage == 'wipe':
        _check_database_wipe(errors, args.mongo_uri)
    else:
        _check_training_artifacts(errors)

    if errors:
        print('[FAIL] Nexus verifier found issues:')
        for error in errors:
            print(f' - {error}')
        return 1

    if args.stage == 'wipe':
        print('[PASS] Database wipe verified: tracked collections are empty and temp CSV files are gone.')
    else:
        print('[PASS] Training verifier succeeded: model artifacts, metrics math, and SHAP export look consistent.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
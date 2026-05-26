import json
from pathlib import Path

import numpy as np
import pandas as pd
from graph_features import build_transaction_graph_features, detect_transaction_graph_input
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    classification_report,
    confusion_matrix,
    fbeta_score,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)


TARGET_COL = 'F3924'
ID_CANDIDATES = ['Account_ID', 'account_id', 'AccountId', 'accountId', 'Unnamed: 0']
HIGH_PRIORITY_FEATURES = [
    'F115', 'F321', 'F527', 'F531', 'F670', 'F1692', 'F2082', 'F2122', 'F2582',
    'F2678', 'F2737', 'F2956', 'F3043', 'F3836', 'F3887', 'F3889', 'F3891', 'F3894',
]
INTERACTION_PAIRS = [
    ('F115', 'F321'),
    ('F531', 'F670'),
    ('F3836', 'F321'),
    ('F3887', 'F3891'),
    ('F3894', 'F3889'),
]

CORRELATION_PRUNE_THRESHOLD = 0.95


def clean_column_names(df: pd.DataFrame) -> pd.DataFrame:
    """Normalize incoming CSV column names so training and inference stay aligned."""
    df = df.copy()
    df.columns = df.columns.astype(str).str.strip()
    if 'Unnamed: 0' in df.columns:
        df = df.rename(columns={'Unnamed: 0': 'Account_ID'})
    return df


def detect_id_column(df: pd.DataFrame):
    for candidate in ID_CANDIDATES:
        if candidate in df.columns:
            return candidate
    return None


def _normalize_numeric_text(value):
    if isinstance(value, str):
        text = value.strip()
        while len(text) >= 2 and ((text.startswith('[') and text.endswith(']')) or (text.startswith('(') and text.endswith(')'))):
            text = text[1:-1].strip()
        return text.replace(',', '')
    return value


def to_numeric_frame(df: pd.DataFrame, exclude=None) -> pd.DataFrame:
    """Force every non-excluded column into a numeric representation."""
    exclude = set(exclude or [])
    numeric = df.copy()
    for column in numeric.columns:
        if column in exclude:
            continue
        numeric[column] = pd.to_numeric(numeric[column].map(_normalize_numeric_text), errors='coerce')
    return numeric.fillna(0.0)


def _safe_divide(numerator, denominator):
    """Divide while swallowing zero-division and invalid-value noise."""
    denominator = denominator.replace(0, np.nan) if isinstance(denominator, pd.Series) else denominator
    result = numerator / denominator
    if isinstance(result, pd.Series):
        return result.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return np.nan_to_num(result)


def engineer_features(X: pd.DataFrame, enable_velocity_features: bool = False) -> pd.DataFrame:
    """Create row-level behavioral features used by both training and inference."""
    engineered = to_numeric_frame(X)
    present_high_priority = [col for col in HIGH_PRIORITY_FEATURES if col in engineered.columns]

    # Aggregate signals help the model reason about magnitude, spread, and burstiness.
    base_abs = engineered.abs()
    engineered['row_non_zero_count'] = (engineered != 0).sum(axis=1)
    engineered['row_abs_sum'] = base_abs.sum(axis=1)
    engineered['row_mean'] = engineered.mean(axis=1)
    engineered['row_std'] = engineered.std(axis=1).fillna(0.0)
    engineered['row_min'] = engineered.min(axis=1)
    engineered['row_max'] = engineered.max(axis=1)
    engineered['feature_density'] = _safe_divide(engineered['row_non_zero_count'], float(max(len(X.columns), 1)))
    engineered['burstiness_index'] = _safe_divide(engineered['row_abs_sum'], engineered['row_non_zero_count'].replace(0, np.nan))

    # Fix: only compute velocity features for sequential data; wide-table rows are independent accounts.
    if enable_velocity_features:
        rolling_mean = engineered['row_abs_sum'].rolling(window=5, min_periods=1).mean()
        engineered['velocity_delta_5'] = engineered['row_abs_sum'].diff().fillna(0.0)
        engineered['velocity_acceleration_5'] = (engineered['row_abs_sum'] - rolling_mean).fillna(0.0)

    if present_high_priority:
        # Preserve the bank-validated signals as explicit rollups so they remain visible in exports.
        high_priority = engineered[present_high_priority]
        high_priority_abs = high_priority.abs()
        engineered['high_priority_signal_sum'] = high_priority.sum(axis=1)
        engineered['high_priority_abs_sum'] = high_priority_abs.sum(axis=1)
        engineered['high_priority_abs_mean'] = high_priority_abs.mean(axis=1)
        engineered['high_priority_abs_max'] = high_priority_abs.max(axis=1)
        engineered['high_priority_abs_min'] = high_priority_abs.min(axis=1)
        engineered['high_priority_positive_count'] = (high_priority > 0).sum(axis=1)
        engineered['high_priority_negative_count'] = (high_priority < 0).sum(axis=1)
        engineered['high_priority_signal_range'] = engineered['high_priority_abs_max'] - engineered['high_priority_abs_min']

        centered = high_priority - high_priority.median(axis=0)
        spread = high_priority.std(axis=0, ddof=0).replace(0, 1.0)
        zscores = centered.div(spread, axis=1)
        engineered['signal_centroid_distance'] = np.sqrt((zscores.pow(2)).sum(axis=1) / float(len(present_high_priority)))
        engineered['signal_graph_proxy_score'] = 1.0 / (1.0 + engineered['signal_centroid_distance'])

        for left, right in INTERACTION_PAIRS:
            if left in engineered.columns and right in engineered.columns:
                engineered[f'{left}_x_{right}'] = engineered[left] * engineered[right]
                engineered[f'{left}_minus_{right}'] = engineered[left] - engineered[right]
                engineered[f'{left}_over_{right}'] = _safe_divide(engineered[left], engineered[right].replace(0, np.nan))

    return engineered.replace([np.inf, -np.inf], 0.0).fillna(0.0)


def prune_correlated_features(X: pd.DataFrame, threshold: float = CORRELATION_PRUNE_THRESHOLD):
    """Drop redundant highly correlated columns while protecting important signals."""
    if X.empty:
        return X.copy(), []

    working = X.copy()
    correlation = working.corr().abs().fillna(0.0)
    upper_triangle = correlation.where(np.triu(np.ones(correlation.shape), k=1).astype(bool))

    protected = set(HIGH_PRIORITY_FEATURES) | {
        'Anomaly_Score',
        'signal_graph_proxy_score',
        'signal_centroid_distance',
        'row_abs_sum',
        'row_std',
        'feature_density',
        'burstiness_index',
    }

    to_drop = []
    for column in upper_triangle.columns:
        correlated = upper_triangle[column][upper_triangle[column] > threshold].index.tolist()
        for candidate in correlated:
            if candidate in protected and column not in protected:
                to_drop.append(column)
                break
            if column in protected and candidate not in protected:
                to_drop.append(candidate)
            elif column not in protected and candidate not in protected:
                to_drop.append(candidate)

    to_drop = sorted(set(to_drop))
    pruned = working.drop(columns=[column for column in to_drop if column in working.columns])
    return pruned, to_drop


def build_threshold_curve(y_true, y_prob, start: float = 0.1, stop: float = 0.99, step: float = 0.01):
    """Generate alert volume and quality metrics for threshold tuning in the dashboard."""
    rows = []
    threshold = start
    while threshold <= stop + 1e-9:
        y_pred = (np.asarray(y_prob) >= threshold).astype(int)
        rows.append({
            'threshold': float(round(threshold, 2)),
            'alert_count': int(y_pred.sum()),
            'precision': float(precision_score(y_true, y_pred, zero_division=0)),
            'recall': float(recall_score(y_true, y_pred, zero_division=0)),
            'f1': float(f1_score(y_true, y_pred, zero_division=0)),
        })
        threshold += step
    return rows


def prepare_dataframe(df: pd.DataFrame, target_col: str = TARGET_COL):
    """Return aligned features, labels, and metadata for downstream model steps."""
    df = clean_column_names(df)

    if detect_transaction_graph_input(df):
        return build_transaction_graph_features(df, target_col=target_col)

    id_col = detect_id_column(df)

    y = None
    if target_col in df.columns:
        y = pd.to_numeric(df[target_col].map(_normalize_numeric_text), errors='coerce').dropna().astype(int)
        df = df.loc[y.index].copy()

    exclude_cols = [target_col]
    if id_col:
        exclude_cols.append(id_col)

    original_feature_count = len([column for column in df.columns if column not in exclude_cols])
    X = to_numeric_frame(df.drop(columns=[c for c in exclude_cols if c in df.columns], errors='ignore'))
    X = engineer_features(X, enable_velocity_features=False)
    feature_columns = list(X.columns)
    entity_ids = df[id_col].astype(str) if id_col else pd.Series([f'ROW-{index}' for index in df.index], index=df.index)
    X.index = entity_ids.values
    if y is not None:
        y = pd.Series(y.to_numpy(), index=X.index, name=target_col)
    metadata = {
        'schema_type': 'wide_table',
        'id_col': id_col,
        'target_col': target_col,
        'feature_columns': feature_columns,
        'high_priority_features': [col for col in HIGH_PRIORITY_FEATURES if col in feature_columns],
        'engineered_feature_count': max(len(feature_columns) - original_feature_count, 0),
    }
    return X, y, metadata


def align_features(df: pd.DataFrame, feature_columns):
    """Project an input frame onto the exact feature schema the model expects."""
    aligned = df.reindex(columns=feature_columns, fill_value=0.0)
    return to_numeric_frame(aligned)


def compute_model_metrics(y_true, y_prob, threshold: float):
    """Compute a concise metrics bundle for the dashboard and exported artifacts."""
    y_pred = (np.asarray(y_prob) >= threshold).astype(int)
    metrics = {
        'threshold': float(threshold),
        'accuracy': float(accuracy_score(y_true, y_pred)),
        'precision': float(precision_score(y_true, y_pred, zero_division=0)),
        'recall': float(recall_score(y_true, y_pred, zero_division=0)),
        'f1': float(f1_score(y_true, y_pred, zero_division=0)),
        'roc_auc': float(roc_auc_score(y_true, y_prob)) if len(np.unique(y_true)) > 1 else 0.0,
        'pr_auc': float(average_precision_score(y_true, y_prob)) if len(np.unique(y_true)) > 1 else 0.0,
        'confusion_matrix': confusion_matrix(y_true, y_pred).tolist(),
        'classification_report': classification_report(y_true, y_pred, zero_division=0, output_dict=True),
        'alert_count': int(y_pred.sum()),
        'sample_count': int(len(y_true)),
    }
    return metrics


def optimize_threshold(y_true, y_prob):
    """Pick the alert threshold that maximizes F-beta (beta=2) on validation probabilities."""
    # Fix: weight recall more heavily than precision so the search favors catching fraud.
    search_space = np.arange(0.05, 0.995, 0.01)
    best_threshold = 0.5
    best_fbeta = -1.0
    best_precision = 0.0
    best_recall = 0.0
    for threshold in search_space:
        y_pred = (np.asarray(y_prob) >= threshold).astype(int)
        fbeta = fbeta_score(y_true, y_pred, beta=2, zero_division=0)
        precision = precision_score(y_true, y_pred, zero_division=0)
        recall = recall_score(y_true, y_pred, zero_division=0)
        if fbeta > best_fbeta or (fbeta == best_fbeta and recall >= best_recall):
            best_threshold = float(threshold)
            best_fbeta = float(fbeta)
            best_precision = float(precision)
            best_recall = float(recall)
    critical_threshold = min(0.99, max(best_threshold + 0.12, 0.95))
    return {
        'alert_threshold': float(round(best_threshold, 2)),
        'critical_threshold': float(round(critical_threshold, 2)),
        'best_fbeta': float(best_fbeta),
        'best_f1': float(best_fbeta),  # Legacy compatibility alias.
        'best_precision': float(best_precision),
        'best_recall': float(best_recall),
    }


def save_json(path, payload):
    """Write JSON payloads atomically enough for local pipeline outputs."""
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open('w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=4)
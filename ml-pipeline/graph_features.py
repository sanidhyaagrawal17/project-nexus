import numpy as np
import pandas as pd


GRAPH_SOURCE_CANDIDATES = [
    'source_account',
    'source_account_id',
    'src_account',
    'sender_account',
    'from_account',
    'origin_account',
    'payer_account',
]
GRAPH_TARGET_CANDIDATES = [
    'destination_account',
    'destination_account_id',
    'dst_account',
    'receiver_account',
    'to_account',
    'beneficiary_account',
    'counterparty_account',
]
GRAPH_AMOUNT_CANDIDATES = [
    'amount',
    'transaction_amount',
    'txn_amount',
    'transfer_amount',
    'value',
]
GRAPH_TIMESTAMP_CANDIDATES = [
    'timestamp',
    'transaction_time',
    'event_time',
    'created_at',
    'date',
    'posted_at',
]
GRAPH_LABEL_CANDIDATES = [
    'F3924',
    'label',
    'target',
    'is_fraud',
    'fraud_label',
    'is_mule',
    'suspicious_label',
]


def _first_present(columns, candidates):
    for candidate in candidates:
        if candidate in columns:
            return candidate
    return None


def detect_transaction_graph_input(df: pd.DataFrame) -> bool:
    """Return True when the frame exposes a transaction edge list."""
    source_col = _first_present(df.columns, GRAPH_SOURCE_CANDIDATES)
    destination_col = _first_present(df.columns, GRAPH_TARGET_CANDIDATES)
    return source_col is not None and destination_col is not None


def _safe_divide(numerator, denominator):
    denominator = denominator.replace(0, np.nan) if isinstance(denominator, pd.Series) else denominator
    result = numerator / denominator
    if isinstance(result, pd.Series):
        return result.replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return np.nan_to_num(result)


def _coerce_timestamp(series):
    timestamps = pd.to_datetime(series, errors='coerce', utc=True)
    try:
        return timestamps.dt.tz_convert(None)
    except Exception:
        return timestamps.dt.tz_localize(None)


def build_transaction_graph_features(df: pd.DataFrame, target_col: str = 'F3924'):
    """Aggregate a transaction edge list into account-level network features."""
    working = df.copy()

    source_col = _first_present(working.columns, GRAPH_SOURCE_CANDIDATES)
    destination_col = _first_present(working.columns, GRAPH_TARGET_CANDIDATES)
    amount_col = _first_present(working.columns, GRAPH_AMOUNT_CANDIDATES)
    timestamp_col = _first_present(working.columns, GRAPH_TIMESTAMP_CANDIDATES)
    label_col = _first_present(working.columns, [target_col] + [candidate for candidate in GRAPH_LABEL_CANDIDATES if candidate != target_col])

    if source_col is None or destination_col is None:
        raise ValueError('Transaction graph input requires source and destination account columns.')

    working = working.dropna(subset=[source_col, destination_col]).copy()
    working[source_col] = working[source_col].astype(str).str.strip()
    working[destination_col] = working[destination_col].astype(str).str.strip()
    working = working[(working[source_col] != '') & (working[destination_col] != '')].copy()

    if working.empty:
        raise ValueError('Transaction graph input does not contain any valid edges.')

    if amount_col is not None:
        working['__amount__'] = pd.to_numeric(working[amount_col], errors='coerce').fillna(0.0)
    else:
        working['__amount__'] = 1.0

    if timestamp_col is not None:
        working['__timestamp__'] = _coerce_timestamp(working[timestamp_col])
    else:
        working['__timestamp__'] = pd.NaT

    working['__abs_amount__'] = working['__amount__'].abs()

    outgoing = pd.DataFrame({
        'entity_id': working[source_col].astype(str),
        'counterparty': working[destination_col].astype(str),
        'amount': working['__amount__'],
        'abs_amount': working['__abs_amount__'],
        'timestamp': working['__timestamp__'],
    })
    outgoing['pair_key'] = list(zip(outgoing['entity_id'], outgoing['counterparty']))
    incoming = pd.DataFrame({
        'entity_id': working[destination_col].astype(str),
        'counterparty': working[source_col].astype(str),
        'amount': working['__amount__'],
        'abs_amount': working['__abs_amount__'],
        'timestamp': working['__timestamp__'],
    })
    outgoing['direction'] = 'out'
    incoming['direction'] = 'in'

    incident = pd.concat([outgoing, incoming], ignore_index=True)
    incident['pair_key'] = list(zip(incident['entity_id'], incident['counterparty']))

    base_stats = incident.groupby('entity_id').agg(
        graph_transaction_count=('amount', 'size'),
        graph_unique_counterparties=('counterparty', 'nunique'),
        graph_amount_sum=('amount', 'sum'),
        graph_amount_mean=('amount', 'mean'),
        graph_amount_std=('amount', 'std'),
        graph_amount_min=('amount', 'min'),
        graph_amount_max=('amount', 'max'),
        graph_amount_median=('amount', 'median'),
        graph_abs_amount_sum=('abs_amount', 'sum'),
    )

    outgoing_stats = outgoing.groupby('entity_id').agg(
        out_transaction_count=('amount', 'size'),
        out_unique_counterparties=('counterparty', 'nunique'),
        out_amount_sum=('amount', 'sum'),
        out_amount_mean=('amount', 'mean'),
        out_amount_std=('amount', 'std'),
        out_amount_min=('amount', 'min'),
        out_amount_max=('amount', 'max'),
        out_abs_amount_sum=('abs_amount', 'sum'),
    )
    incoming_stats = incoming.groupby('entity_id').agg(
        in_transaction_count=('amount', 'size'),
        in_unique_counterparties=('counterparty', 'nunique'),
        in_amount_sum=('amount', 'sum'),
        in_amount_mean=('amount', 'mean'),
        in_amount_std=('amount', 'std'),
        in_amount_min=('amount', 'min'),
        in_amount_max=('amount', 'max'),
        in_abs_amount_sum=('abs_amount', 'sum'),
    )

    if timestamp_col is not None:
        ordered = incident.dropna(subset=['timestamp']).sort_values(['entity_id', 'timestamp'])
        if not ordered.empty:
            ordered['interarrival_minutes'] = ordered.groupby('entity_id')['timestamp'].diff().dt.total_seconds().div(60.0)

            def _active_span_hours(series):
                valid = series.dropna()
                if len(valid) < 2:
                    return 0.0
                return float((valid.max() - valid.min()).total_seconds() / 3600.0)

            def _transaction_frequency(series):
                valid = series.dropna()
                if len(valid) < 2:
                    return float(len(valid))
                span_hours = max(_active_span_hours(valid), 1.0 / 60.0)
                return float(len(valid) / span_hours)

            time_stats = ordered.groupby('entity_id').agg(
                first_transaction_time=('timestamp', 'min'),
                last_transaction_time=('timestamp', 'max'),
                active_span_hours=('timestamp', _active_span_hours),
                mean_interarrival_minutes=('interarrival_minutes', 'mean'),
                median_interarrival_minutes=('interarrival_minutes', 'median'),
                transaction_frequency_per_hour=('timestamp', _transaction_frequency),
            )
        else:
            time_stats = pd.DataFrame()
    else:
        time_stats = pd.DataFrame()

    reverse_pairs = set(zip(working[destination_col].astype(str), working[source_col].astype(str)))
    outgoing = outgoing.assign(has_reverse=outgoing['pair_key'].isin(reverse_pairs))
    reciprocal_stats = outgoing.groupby('entity_id').agg(
        reciprocal_transaction_count=('has_reverse', 'sum'),
    )

    self_loop_stats = working.loc[working[source_col] == working[destination_col]].groupby(source_col).size().rename('self_loop_count').to_frame()
    top_counterparty_stats = incident.groupby(['entity_id', 'counterparty']).size().groupby(level=0).max().rename('top_counterparty_count').to_frame()

    features = base_stats.join(outgoing_stats, how='left')
    features = features.join(incoming_stats, how='left')
    features = features.join(time_stats, how='left')
    features = features.join(reciprocal_stats, how='left')
    features = features.join(self_loop_stats, how='left')
    features = features.join(top_counterparty_stats, how='left')
    features = features.fillna(0.0)

    features['graph_direction_balance'] = _safe_divide(features['out_transaction_count'] - features['in_transaction_count'], features['graph_transaction_count'])
    features['graph_flow_imbalance'] = _safe_divide((features['out_amount_sum'] - features['in_amount_sum']).abs(), features['graph_abs_amount_sum'])
    features['graph_counterparty_reuse_rate'] = _safe_divide(features['graph_transaction_count'] - features['graph_unique_counterparties'], features['graph_transaction_count'])
    features['graph_counterparty_concentration'] = _safe_divide(features['top_counterparty_count'], features['graph_transaction_count'])
    features['graph_reciprocity_rate'] = _safe_divide(features['reciprocal_transaction_count'], features['out_transaction_count'])
    features['graph_self_loop_rate'] = _safe_divide(features['self_loop_count'], features['out_transaction_count'])
    features['graph_in_out_count_ratio'] = _safe_divide(features['out_transaction_count'], features['in_transaction_count'])
    features['graph_amount_balance_ratio'] = _safe_divide(features['out_amount_sum'], features['in_amount_sum'])
    features['graph_amount_spread'] = features['graph_amount_max'] - features['graph_amount_min']
    features['graph_activity_intensity'] = _safe_divide(features['graph_transaction_count'], features['graph_unique_counterparties'].replace(0, np.nan))
    features['graph_avg_ticket_size'] = _safe_divide(features['graph_abs_amount_sum'], features['graph_transaction_count'])

    datetime_columns = features.select_dtypes(include=['datetime64[ns]', 'datetimetz']).columns
    for column in datetime_columns:
        timestamps = pd.to_datetime(features[column], errors='coerce', utc=True)
        numeric_timestamps = pd.Series(timestamps.astype('int64') / 1_000_000_000, index=features.index)
        features[column] = numeric_timestamps.where(timestamps.notna(), np.nan)

    features.index.name = 'Account_ID'

    y = None
    actual_label_col = label_col
    if actual_label_col is not None:
        label_frame = working[[source_col, actual_label_col]].copy()
        label_frame[actual_label_col] = pd.to_numeric(label_frame[actual_label_col], errors='coerce').fillna(0).astype(int)
        y = label_frame.groupby(source_col)[actual_label_col].max().reindex(features.index, fill_value=0).astype(int)
        y.index.name = 'Account_ID'

    metadata = {
        'schema_type': 'transaction_graph',
        'entity_id_col': source_col,
        'target_col': actual_label_col,
        'graph_source_col': source_col,
        'graph_target_col': destination_col,
        'graph_amount_col': amount_col,
        'graph_timestamp_col': timestamp_col,
        'feature_columns': list(features.columns),
        'high_priority_features': [],
        'engineered_feature_count': int(len(features.columns)),
        'graph_summary': {
            'edge_count': int(len(working)),
            'node_count': int(len(features)),
            'labelled_node_count': int(len(y)) if y is not None else 0,
        },
    }

    return features.astype(float), y, metadata
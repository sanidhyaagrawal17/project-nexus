from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from feature_utils import TARGET_COL, clean_column_names, detect_id_column


BASE_DIR = Path(__file__).resolve().parent


def _load_feedback_labels():
    try:
        from pymongo import MongoClient
    except Exception as exc:
        raise RuntimeError(f'pymongo is unavailable: {exc}') from exc

    mongo_uri = os.getenv('MONGO_URI') or os.getenv('MONGODB_URI') or 'mongodb://localhost:27017'
    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=4000)
    db = client['nexusDB']
    collection = db['AnalystFeedback']
    records = list(collection.find(
        {'decision': {'$in': ['CONFIRMED_FRAUD', 'SAFE']}},
        {'_id': 0, 'accountId': 1, 'Account_ID': 1, 'decision': 1},
    ))

    labels = {}
    for record in records:
        account_id = record.get('accountId', record.get('Account_ID'))
        decision = record.get('decision')
        if account_id is None or decision not in ('CONFIRMED_FRAUD', 'SAFE'):
            continue
        labels[str(account_id)] = 1 if decision == 'CONFIRMED_FRAUD' else 0

    print(f'[*] Loaded {len(labels)} verified analyst feedback labels from MongoDB.')
    return labels


def _resolve_historical_dataset():
    candidate = os.getenv('NEXUS_DATA_PATH')
    if candidate:
        return Path(candidate)
    return BASE_DIR / 'data' / 'demo_upload_data.csv'


def _merge_feedback_into_history(history_path: Path, feedback_labels: dict[str, int]):
    if not history_path.exists():
        raise FileNotFoundError(f'Historical dataset not found at {history_path}')

    history_df = clean_column_names(pd.read_csv(history_path, low_memory=False))
    id_col = detect_id_column(history_df)
    if id_col is None:
        raise RuntimeError('Historical dataset does not expose an account identifier column.')

    merged_df = history_df.copy()
    merged_df[id_col] = merged_df[id_col].astype(str)
    if TARGET_COL not in merged_df.columns:
        merged_df[TARGET_COL] = pd.NA

    feedback_series = pd.Series(feedback_labels, dtype='float64')
    matched_mask = merged_df[id_col].isin(feedback_series.index)
    merged_df.loc[matched_mask, TARGET_COL] = merged_df.loc[matched_mask, id_col].map(feedback_series)
    merged_df[TARGET_COL] = pd.to_numeric(merged_df[TARGET_COL], errors='coerce')

    return merged_df, id_col, int(matched_mask.sum())


def _write_retrain_dataset(df: pd.DataFrame):
    output_dir = BASE_DIR / 'data'
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    output_path = output_dir / f'active_learning_retrain_{timestamp}.csv'
    df.to_csv(output_path, index=False)
    return output_path


def main():
    feedback_labels = _load_feedback_labels()
    history_path = _resolve_historical_dataset()
    merged_df, id_col, matched_count = _merge_feedback_into_history(history_path, feedback_labels)
    merged_path = _write_retrain_dataset(merged_df)

    print(f'[*] Merged {matched_count} feedback records into historical dataset using {id_col}.')
    print(f'[*] Retrain dataset written to {merged_path}.')

    env = os.environ.copy()
    env['NEXUS_DATA_PATH'] = str(merged_path)

    command = [sys.executable, 'train_nexus.py', '--retrain-with-feedback']
    result = subprocess.run(command, cwd=str(BASE_DIR), env=env)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
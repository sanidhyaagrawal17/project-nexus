import pandas as pd
import numpy as np
import os
import time
from datetime import datetime, timedelta


def generate_transaction_graph_csv(filename='demo_transaction_graph.csv', num_accounts=240, num_transactions=1800):
    """Create a realistic transaction edge list for graph-based model training."""
    print("=== Generating Project Nexus Transaction Graph Demo Data ===")
    start_time = time.time()

    rng = np.random.default_rng(42)
    accounts = [f'ACC-{8000 + index}' for index in range(num_accounts)]
    risky_accounts = set(rng.choice(accounts, size=max(12, num_accounts // 18), replace=False))
    routing_hubs = list(rng.choice(accounts, size=max(8, num_accounts // 24), replace=False))

    base_time = datetime(2026, 5, 1, 8, 0, 0)
    rows = []

    for index in range(num_transactions):
        source = rng.choice(accounts)
        source_is_risky = source in risky_accounts

        if source_is_risky:
            destination_pool = [account for account in accounts if account != source]
            destination = rng.choice(destination_pool)
            amount = abs(rng.normal(8200, 2600))
            transaction_type = rng.choice(['WIRE_TRANSFER', 'CRYPTO_EXCHANGE', 'P2P_PAYMENT'], p=[0.4, 0.35, 0.25])
            channel = rng.choice(['mobile', 'web', 'branch'], p=[0.58, 0.28, 0.14])
            timestamp_offset = int(index * 11 + rng.integers(0, 55))
            timestamp = base_time + timedelta(minutes=timestamp_offset)
        else:
            destination = rng.choice(routing_hubs if rng.random() < 0.65 else accounts)
            if destination == source:
                destination = rng.choice([account for account in accounts if account != source])
            amount = abs(rng.normal(640, 280))
            transaction_type = rng.choice(['CARD_PAYMENT', 'P2P_PAYMENT', 'BILLPAY', 'ACH_TRANSFER'])
            channel = rng.choice(['mobile', 'web', 'branch'], p=[0.42, 0.45, 0.13])
            timestamp_offset = int(index * 14 + rng.integers(0, 160))
            timestamp = base_time + timedelta(minutes=timestamp_offset)

        if source_is_risky and rng.random() < 0.2:
            destination = rng.choice([account for account in accounts if account != source])

        rows.append({
            'transaction_id': f'TXN-{index + 1:06d}',
            'source_account': source,
            'destination_account': destination,
            'amount': round(float(amount), 2),
            'timestamp': timestamp.isoformat(),
            'transaction_type': transaction_type,
            'channel': channel,
            'F3924': int(source_is_risky),
        })

        if source_is_risky and rng.random() < 0.15:
            rows.append({
                'transaction_id': f'TXN-{index + 1:06d}-R',
                'source_account': destination,
                'destination_account': source,
                'amount': round(float(amount * rng.uniform(0.35, 0.7)), 2),
                'timestamp': (timestamp + timedelta(minutes=int(rng.integers(3, 240)))).isoformat(),
                'transaction_type': rng.choice(['WIRE_TRANSFER', 'CRYPTO_EXCHANGE', 'P2P_PAYMENT']),
                'channel': rng.choice(['mobile', 'web', 'branch']),
                'F3924': int(destination in risky_accounts),
            })

    df = pd.DataFrame(rows)

    output_dir = 'data'
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, filename)
    df.to_csv(output_path, index=False)

    elapsed = time.time() - start_time
    print(f"[+] Success! Graph demo file '{filename}' generated in {elapsed:.2f}s with {len(df)} transactions.")

def generate_hackathon_csv(filename='demo_upload_data.csv', num_rows=500):
    print("=== Initializing Project Nexus Demo Data Generator ===")
    start_time = time.time()
    
    # 1. Generate numeric matrix
    print(f"[*] Constructing schema with {num_rows} rows and 3,925 columns...")
    data = np.random.randn(num_rows, 3924)
    
    # 2. Create DataFrame and immediately cast to 'object' 
    # This prevents the 'LossySetitemError' when we inject strings later
    df = pd.DataFrame(data, columns=[f'F{i}' for i in range(1, 3925)])
    df = df.astype(object) 
    
    # 3. Add ID and Target
    df.insert(0, 'Unnamed: 0', [f'DEMO-ACC-{8000+i}' for i in range(num_rows)])
    df['F3924'] = np.random.choice([0, 1], size=num_rows, p=[0.95, 0.05])
    
    # 4. Embed Fraud Patterns
    print("[*] Embedding predictive signals...")
    mule_idx = df['F3924'] == 1
    
    # Using .loc with explicit column names
    df.loc[mule_idx, 'F3912'] = df.loc[mule_idx, 'F3912'].astype(float) + 6.0
    df.loc[mule_idx, 'F3799'] = df.loc[mule_idx, 'F3799'].astype(float) + 5.5
    df.loc[mule_idx, 'F1165'] = df.loc[mule_idx, 'F1165'].astype(float) - 4.0
    
    # 5. Inject "Dirty Data" - This will now work because df is 'object' type
    print("[*] Injecting text artifacts ('Oct25', 'Pending')...")
    noise_indices = np.random.choice(num_rows, size=min(20, num_rows), replace=False)
    df.loc[noise_indices, 'F50'] = 'Oct25'
    df.loc[noise_indices, 'F100'] = 'Pending'
    
    # 6. Export
    output_dir = 'data'
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, filename)
    
    df.to_csv(output_path, index=False)
    print(f"[+] Success! Demo file '{filename}' generated.")

if __name__ == "__main__":
    generate_hackathon_csv()
    generate_transaction_graph_csv()
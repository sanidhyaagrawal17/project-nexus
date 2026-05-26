# Transaction Graph Input Format

Project Nexus now accepts a real transaction edge list in addition to the legacy wide account table.

Required columns:

- `source_account` - the originating account for the transfer
- `destination_account` - the receiving account for the transfer

Recommended columns:

- `amount` - transaction value
- `timestamp` - transaction time in ISO 8601 or CSV-friendly datetime format
- `transaction_type` - transfer category
- `channel` - channel used for the transaction
- `F3924` - account-level label for the source account

What the pipeline builds:

- outbound and inbound transaction counts
- unique counterparty counts
- amount sum, mean, min, max, median, and spread
- reciprocity, self-loop, and counterparty concentration features
- activity span and inter-arrival timing features when timestamps are present

If a label column is present, it is aggregated at the source-account level so the model still predicts risk per account rather than per row.
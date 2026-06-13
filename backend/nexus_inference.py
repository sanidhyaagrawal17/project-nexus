import sys
import json
import pandas as pd
import numpy as np
import joblib
import shap
import warnings

# Suppress warnings to keep standard output clean for Node.js IPC
warnings.filterwarnings('ignore')

def run_inference(csv_path):
    try:
        # 1. Load the frozen models and schema
        model = joblib.load('ml_models/nexus_xgboost.pkl')
        calibrator = joblib.load('ml_models/nexus_calibrated_model.pkl')
        iso_forest = joblib.load('ml_models/nexus_iso_forest.pkl')
        scaler = joblib.load('ml_models/nexus_anomaly_scaler.pkl')
        expected_features = joblib.load('ml_models/nexus_feature_schema.pkl')

        # 2. Load and align the dataset
        df = pd.read_csv(csv_path)
        account_ids = df['ACCOUNT_ID'] if 'ACCOUNT_ID' in df.columns else df.index
        
        # Ensure exact column match with training data (impute missing with 0)
        X = df.reindex(columns=expected_features, fill_value=0)

        # 3. Vectorized Predictions (Extremely Fast)
        raw_anomaly = iso_forest.score_samples(X)
        anomaly_scores = scaler.transform(raw_anomaly.reshape(-1, 1)).flatten()
        fraud_probs = calibrator.predict_proba(X)[:, 1]

        # 4. Conditional SHAP Explainability (The massive time-saver)
        # Only compute SHAP for rows where probability > 0.70 (High Risk/Critical)
        explainer = shap.TreeExplainer(model)
        flagged_indices = np.where(fraud_probs >= 0.70)[0]
        
        if len(flagged_indices) > 0:
            X_flagged = X.iloc[flagged_indices]
            shap_values_flagged = explainer.shap_values(X_flagged)
        else:
            shap_values_flagged = []

        # 5. Build the Payload (Clean Vectorized Data Prep)
        risk_scores = fraud_probs * 100
        
        # Vectorized status assignment
        statuses = np.where(risk_scores >= 95.0, 'Critical', 
                            np.where(risk_scores >= 85.0, 'High Risk', 'Safe'))
        
        flagged_dict = dict(zip(flagged_indices, range(len(flagged_indices))))
        results = []

        # Fast payload construction
        for i in range(len(df)):
            top_features = []
            if i in flagged_dict:
                shap_idx = flagged_dict[i]
                row_shap = shap_values_flagged[shap_idx]
                
                # Get indices of top 3 features by absolute SHAP impact
                top_indices = np.argsort(np.abs(row_shap))[-3:][::-1]
                
                for feat_idx in top_indices:
                    top_features.append({
                        "name": expected_features[feat_idx],
                        "raw": float(X.iloc[i, feat_idx]),
                        "contribution": float(row_shap[feat_idx])
                    })

            results.append({
                "accountId": str(account_ids[i]),
                "riskScore": float(risk_scores[i]),
                "anomalyScore": float(anomaly_scores[i]),
                "status": str(statuses[i]),
                "topFeatures": top_features
            })

        # Output pure JSON to stdout for Node.js to consume
        print(json.dumps({"success": True, "data": results}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No CSV path provided"}))
        sys.exit(1)
    
    csv_file_path = sys.argv[1]
    run_inference(csv_file_path)
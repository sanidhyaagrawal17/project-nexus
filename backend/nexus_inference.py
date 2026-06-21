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
        
        # Strip Anomaly_Score for IsoForest
        feature_columns = expected_features[:-1] if expected_features and expected_features[-1] == 'Anomaly_Score' else expected_features

        # Ensure exact column match with training data (impute missing with 0)
        X_base = df.reindex(columns=feature_columns, fill_value=0)

        # Coerce all columns to numeric, filling non-convertible with 0
        for col in X_base.columns:
            X_base[col] = pd.to_numeric(X_base[col], errors='coerce').fillna(0.0)

        # 3. Vectorized Predictions (Extremely Fast)
        # Use decision_function to match training pipeline
        raw_anomaly = iso_forest.decision_function(X_base)
        
        # Scale anomaly scores
        min_score = scaler.get('min', float(np.min(raw_anomaly)))
        max_score = scaler.get('max', float(np.max(raw_anomaly)))
        if max_score > min_score:
            anomaly_scores = ((raw_anomaly - min_score) / (max_score - min_score)) * 100
        else:
            anomaly_scores = np.zeros(len(raw_anomaly))

        # Add Anomaly_Score for XGBoost
        X = X_base.copy()
        X['Anomaly_Score'] = anomaly_scores
        X = X.reindex(columns=expected_features, fill_value=0)

        fraud_probs = calibrator.predict_proba(X)[:, 1]

        # Try to extract the base XGBoost model from the CalibratedClassifierCV
        if hasattr(calibrator, 'estimator'):
            model = calibrator.estimator
        elif hasattr(calibrator, 'calibrated_classifiers_'):
            model = calibrator.calibrated_classifiers_[0].estimator
        else:
            model = calibrator

        # PATCH FOR XGBOOST 3.0+ BASE SCORE FORMAT BUG IN SHAP
        try:
            import json
            booster = model.get_booster()
            config = json.loads(booster.save_config())
            if 'learner' in config and 'learner_model_param' in config['learner']:
                base_score = config['learner']['learner_model_param'].get('base_score')
                if base_score == '[5E-1]' or getattr(base_score, 'startswith', lambda x: False)('['):
                    config['learner']['learner_model_param']['base_score'] = '0.5'
                    booster.load_config(json.dumps(config))
        except Exception as e:
            print("Warning: Failed to patch XGBoost config:", e)

        # 4. Conditional SHAP Explainability (The massive time-saver)
        # Monkeypatch float to fix SHAP bug with XGBoost 3.X
        import builtins
        _original_float = builtins.float
        def _patched_float(v):
            if isinstance(v, str) and (v == '[5E-1]' or getattr(v, 'startswith', lambda x: False)('[')):
                return 0.5
            return _original_float(v)
        builtins.float = _patched_float
        
        try:
            # Use TreeExplainer on the original model
            explainer = shap.TreeExplainer(model)
        finally:
            builtins.float = _original_float
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
        import traceback
        traceback.print_exc()
        print(json.dumps({"success": False, "error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No CSV path provided"}))
        sys.exit(1)
    
    csv_file_path = sys.argv[1]
    run_inference(csv_file_path)
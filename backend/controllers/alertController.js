const fs = require('fs');
const path = require('path');

const getAlerts = (req, res) => {
    try {
        // Navigate up from the 'controllers' folder to find the Python output
        const jsonPath = path.join(__dirname, '../../ml-pipeline/nexus_alerts.json');
        
        if (!fs.existsSync(jsonPath)) {
            return res.status(404).json({ 
                success: false, 
                message: "Threat data not found. Please run the Python pipeline first." 
            });
        }

        // Read and parse the XGBoost predictions
        const rawData = fs.readFileSync(jsonPath);
        const threatData = JSON.parse(rawData);
        
        // The JSON file already contains the { success, count, data } structure
        res.status(200).json(threatData);
        
    } catch (error) {
        console.error("Error fetching alerts:", error);
        res.status(500).json({ success: false, message: "Server Error fetching threat data" });
    }
};

module.exports = {
    getAlerts
};
const featureNarratives = {
    'F115': 'exhibited high-velocity transfer bursts indicative of rapid fund movement',
    'F321': 'demonstrated immediate cash-out behavior following incoming deposits',
    'F527': 'showed significant geographic or IP address mismatches compared to established baselines',
    'F531': 'engaged in off-hours transaction spikes atypical for the account profile',
    'F670': 'utilized structured transaction splitting to potentially evade reporting thresholds',
    'F1692': 'established linkages with new and unverified beneficiaries',
    'F2082': 'accessed the platform using a device shared with known high-risk accounts',
    'F2122': 'displayed multi-account overlap suggestive of organized network activity',
    'F2582': 'engaged in rapid merchant cycling, frequently switching payment endpoints',
    'F2678': 'experienced short-lived balance spikes followed by immediate depletion',
    'F2737': 'utilized complex cross-border routing patterns',
    'F2956': 'broke a prolonged period of dormancy with sudden high-value activity',
    'F3043': 'escalated transaction volumes significantly during nighttime hours',
    'F3836': 'breached established velocity caps for the account tier',
    'F3887': 'participated in circular flow patterns indicative of wash trading or layering',
    'F3889': 'showed a spike in the pass-through ratio, acting primarily as a conduit for funds',
    'F3891': 'concentrated transfers among a tight cluster of related parties',
    'F3894': 'demonstrated network reciprocity spikes typical of coordinated mule rings',
    'Anomaly_Score': 'deviated significantly from expected statistical behavioral models',
};

function generateSarDraft(alert) {
    const accountId = alert.accountId || 'UNKNOWN_ACCOUNT';
    const dateStr = alert.detectedAt ? new Date(alert.detectedAt).toLocaleDateString() : 'an unknown date';
    const riskScore = alert.riskScore || 0;
    
    let kycName = 'the subject';
    if (alert.kycDetails && alert.kycDetails.name) {
        kycName = alert.kycDetails.name;
    }

    let narrative = `On ${dateStr}, Project Nexus automated surveillance systems flagged account ${accountId} (associated with ${kycName}) for suspicious activity. The account received a composite Risk Score of ${riskScore.toFixed(1)}%, surpassing the escalation threshold. `;

    if (alert.topFeatures && alert.topFeatures.length > 0) {
        narrative += `The primary drivers for this alert indicate that the account `;
        const fragments = alert.topFeatures.map(f => {
            const code = f.name || f.feature || f.code;
            return featureNarratives[code] || `exhibited anomalous behavior matching pattern ${code}`;
        });
        
        if (fragments.length === 1) {
            narrative += `${fragments[0]}. `;
        } else if (fragments.length === 2) {
            narrative += `${fragments[0]} and ${fragments[1]}. `;
        } else {
            const last = fragments.pop();
            narrative += `${fragments.join(', ')}, and ${last}. `;
        }
    } else {
        narrative += `The system detected generalized anomalous behavior without specific feature attribution. `;
    }

    if (alert.anomalyScore !== undefined) {
        narrative += `Furthermore, the underlying anomaly detection model registered a deviation score of ${Number(alert.anomalyScore).toFixed(2)}, reinforcing the assessment of abnormal financial behavior. `;
    }

    narrative += `Based on these deterministic programmatic indicators, this activity warrants further manual investigation for potential money laundering or fraudulent conduct.`;

    return narrative;
}

module.exports = { generateSarDraft };

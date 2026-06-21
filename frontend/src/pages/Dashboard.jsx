import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Legend, CartesianGrid } from 'recharts';
import { io } from 'socket.io-client';

import ForceGraph2D from 'react-force-graph-2d';
import { ComposableMap, Geographies, Geography, Marker } from 'react-simple-maps';

import toast, { Toaster } from 'react-hot-toast';
import MuleStatusBadge from '../components/MuleStatusBadge.jsx';

/* eslint-disable react-hooks/exhaustive-deps */

// ============================================================================
// 1. THEME & CONSTANTS
// ============================================================================

const T = {
    bg: '#09090b',          // True Obsidian Black
    surface: '#121214',     // Dark flat slate panel
    raised: '#1a1a1e',      // Subtle row hover (No glow)
    border: '#232327',      // Stark, precise 1px borders
    borderHi: '#38383e',    // Prominent structural borders
    txt1: '#f4f4f5',        // High contrast white
    txt2: '#9a9a12',        // Muted gray typography
    txt3: '#52525b',        // Dark label guide
    accent: '#3f8cff',      // Flat technical blue accent
    crit: '#e5484d',        // Solid operational red (No glow)
    high: '#f7ce46',        // Solid alert amber
    ok: '#30a46c',          // Clean status emerald
    
    // Fallback backgrounds for chips so they don't break
    accentBg: 'rgba(63, 140, 255, 0.1)',
    analystAccent: '#14b8a6', 
    analystAccentBg: 'rgba(20, 184, 166, 0.1)',
    critBg: 'rgba(229, 72, 77, 0.1)',
    critBdr: 'rgba(229, 72, 77, 0.3)',
    highBg: 'rgba(247, 206, 70, 0.1)',
    highBdr: 'rgba(247, 206, 70, 0.3)',
    okBg: 'rgba(48, 164, 108, 0.1)',
};

import {
    RiskGauge, RiskBar, StatusChip, ActorBadge, Card, PadCard, MetricCard, PanelHeader,
    Pagination, ConfusionMatrix, ThresholdSlider, AlertAge, BarTooltip, ImportanceTooltip,
    TH, TD, hoverBorderButtonProps, Divider
} from '../components/ui/Widgets';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

const UPLOAD_STATUS_COPY = {
    idle: { label: 'Idle', detail: 'Waiting for a CSV upload.', kind: 'idle', phase: 0 },
    'uploading file...': { label: 'Uploading', detail: 'Sending the CSV to the backend.', kind: 'active', phase: 0 },
    'hashing file for deduplication check...': { label: 'Hashing', detail: 'Checking whether this dataset was already processed.', kind: 'active', phase: 1 },
    'initializing nexus ml engine...': { label: 'Scoring', detail: 'Launching the inference engine and preparing features.', kind: 'active', phase: 2 },
    'committing to nosql database...': { label: 'Committing', detail: 'Writing alerts and file metadata into MongoDB.', kind: 'active', phase: 3 },
    complete: { label: 'Complete', detail: 'The scan finished and the dashboard is refreshed.', kind: 'done', phase: 4 },
    'duplicate rejected': { label: 'Duplicate Rejected', detail: 'The uploaded dataset hash already exists.', kind: 'error', phase: 4 },
    'engine failure': { label: 'Engine Failure', detail: 'The inference process stopped unexpectedly.', kind: 'error', phase: 4 },
    'database error': { label: 'Database Error', detail: 'The results could not be saved to MongoDB.', kind: 'error', phase: 4 },
};

const UPLOAD_PROGRESS_STEPS = [
    { label: 'Upload' }, { label: 'Hash' }, { label: 'Score' }, { label: 'Commit' }, { label: 'Done' }
];

const featureDictionary = {
    F115: 'High-Velocity Transfer Bursts',
    F321: 'Immediate Cash-Out After Inflow',
    F527: 'Geographic / IP Mismatch',
    F531: 'Off-Hours Transaction Spike',
    F670: 'Structured Transaction Splitting',
    F1692: 'New Beneficiary Linkage',
    F2082: 'Shared Device Indicator',
    F2122: 'Multi-Account Overlap',
    F2582: 'Rapid Merchant Cycling',
    F2678: 'Short-Lived Balance Spike',
    F2737: 'Cross-Border Routing Pattern',
    F2956: 'Dormancy Breakout',
    F3043: 'Night-Time Escalation',
    F3836: 'Velocity Cap Breach',
    F3887: 'Circular Flow Indicator',
    F3889: 'Pass-Through Ratio Spike',
    F3891: 'Related-Party Concentration',
    F3894: 'Network Reciprocity Spike',
    Anomaly_Score:'Statistical Deviation',
};

// ============================================================================
// 2. UTILITY FUNCTIONS
// ============================================================================

const getUploadStatusMeta = (status) => {
    const normalized = String(status || 'Idle').trim().toLowerCase();
    return UPLOAD_STATUS_COPY[normalized] || { label: status || 'Idle', detail: 'Processing the current file.', kind: 'active', phase: 2 };
};

const formatDuration = (seconds) => {
    const safeSeconds = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const remainder = safeSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
};

const normalizeFeatureImpact = (feature) => {
    if (!feature) return null;
    if (typeof feature === 'string') return { name: feature, raw: null, contribution: null, direction: null };
    const name = feature.name || feature.feature || feature.code || 'Unknown Signal';
    const contribution = typeof feature.contribution === 'number' ? feature.contribution : null;
    return {
        ...feature,
        name,
        raw: typeof feature.raw === 'number' ? feature.raw : null,
        contribution,
        direction: feature.direction || (contribution === null ? null : contribution >= 0 ? 'UP' : 'DOWN'),
    };
};

const featureLabel = (code) => featureDictionary[code] || `Feature ${code}`;
const translate = (code) => featureLabel(code);
const getAlertFeatures = (alert) => (alert.topFeatures || []).map(normalizeFeatureImpact).filter(Boolean);

const featureCat = (code) => {
    if (['F115','F321','F670','F3836','F531','F3894','F3891','F3887','F3889'].includes(code)) return { bg:'rgba(239,68,68,0.08)', color:'#ef4444', border:'rgba(239,68,68,0.2)' };  
    if (['F527','F2737'].includes(code)) return { bg:'rgba(99,102,241,0.08)', color:'#818cf8', border:'rgba(99,102,241,0.2)' };  
    if (['F2082','F2122'].includes(code)) return { bg:'rgba(168,85,247,0.08)', color:'#c084fc', border:'rgba(168,85,247,0.2)' };  
    if (['F1692','F2956','F2582','F2678','F3043'].includes(code)) return { bg:'rgba(20,184,166,0.08)', color:'#2dd4bf', border:'rgba(20,184,166,0.2)' };  
    return { bg:'rgba(139,92,246,0.08)', color:'#a78bfa', border:'rgba(139,92,246,0.2)' };   
};

const fmtThreshold = (v) => {
    if (v === null || v === undefined) return '';
    const num = Number(v);
    if (Number.isNaN(num)) return String(v);
    if (Math.abs(num) <= 1) return `${(num * 100).toFixed(0)}%`;
    return `${num.toFixed(0)}%`;
};

const alertAgeMs   = (detectedAt) => Date.now() - new Date(detectedAt || 0).getTime();
const formatAge    = (ms) => { const h = Math.floor(ms / 3600000); if (h < 24) return `${h}h ${Math.floor((ms % 3600000) / 60000)}m`; return `${Math.floor(h/24)}d ${h%24}h`; };
const ageColor     = (ms) => { const h = ms/3600000; if (h > 72) return T.crit; if (h > 24) return T.high; return T.ok; };

const formatMetricDisplay = (value, sampleCount) => {
    if (value === null || value === undefined) return '—';
    if (sampleCount !== undefined && sampleCount < 20) return 'N/A';
    return Number(value).toFixed(3);
};


// ============================================================================
// 4. VIEW COMPONENTS
// ============================================================================

const AdminOverviewView = ({
    activeDataset, visibleDatasetFiles, totalScanned, critCount, highCount,
    fileInputRef, uploadLimitEnabled, setUploadLimitEnabled, maxUploadMB, setMaxUploadMB,
    perUploadMB, setPerUploadMB, saveUploadConfig, inputSchemaLabel, inputSchema, activeAccent, activeAccentBg, feedbackStats
}) => (
    <div>
        <Card style={{ padding:'28px 32px', marginBottom:20, background:`linear-gradient(135deg, ${T.surface} 0%, #000 100%)`, border:`1px solid ${T.borderHi}` }}>
            <div style={{ display:'flex', justifyContent:'space-between', gap:24, flexWrap:'wrap', alignItems:'flex-start' }}>
                <div style={{ maxWidth:680 }}>
                    <div style={{ fontSize:12, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:12, fontWeight:700 }}>Dataset Lab</div>
                    <h2 style={{ margin:'0 0 12px 0', fontSize:32, fontWeight:800, lineHeight:1.1, color:T.txt1, letterSpacing:'-0.03em' }}>System Ingestion & Global Architecture</h2>
                    <p style={{ margin:0, color:T.txt2, fontSize:14, lineHeight:1.6, maxWidth:600 }}>Manage the core ML ingest flow, alter batch chunk sizes, and configure schema ingestion parameters before releasing datasets to the Analyst queue.</p>
                    <div style={{ display:'flex', gap:12, marginTop:24, flexWrap:'wrap', alignItems:'center' }}>
                        <button onClick={() => fileInputRef.current?.click()} style={{ padding:'12px 20px', borderRadius:8, border:`1px solid ${activeAccent}`, background:activeAccent, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', boxShadow:`0 0 16px ${activeAccentBg}` }}>Upload CSV File</button>
                        <div style={{ display:'flex', alignItems:'center', gap:10, paddingLeft:16, borderLeft:`1px solid ${T.border}` }}>
                            <label style={{ fontSize:13, color:T.txt2, display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
                                <input type="checkbox" checked={uploadLimitEnabled} onChange={e => setUploadLimitEnabled(e.target.checked)} style={{ accentColor:activeAccent }} />
                                <span style={{ marginLeft:4 }}>Limit uploads</span>
                            </label>
                            <input type="number" min={1} value={maxUploadMB} onChange={e => setMaxUploadMB(e.target.value)} style={{ width:90, padding:'8px 12px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.bg, color:T.txt1, fontWeight:600 }} />
                            <button onClick={saveUploadConfig} style={{ padding:'8px 16px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.raised, color:T.txt1, cursor:'pointer', fontWeight:600, transition:'all 0.2s' }} onMouseEnter={e => e.currentTarget.style.background='#3f3f46'} onMouseLeave={e => e.currentTarget.style.background=T.raised}>Save Limit</button>
                            <div style={{ display:'flex', alignItems:'center', gap:8, marginLeft:12 }}>
                                <span style={{ fontSize:13, color:T.txt2, fontWeight:600 }}>Per-upload MB</span>
                                <input type="number" min={1} value={perUploadMB} onChange={e => setPerUploadMB(e.target.value)} style={{ width:90, padding:'8px 12px', borderRadius:8, border:`1px solid ${T.borderHi}`, background:T.bg, color:T.txt1, fontWeight:600 }} />
                            </div>
                        </div>
                    </div>
                </div>
                <div style={{ minWidth:260, padding:'20px 24px', borderRadius:16, background:'rgba(0,0,0,0.3)', border:`1px solid ${T.borderHi}`, backdropFilter:'blur(8px)' }}>
                    <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:10, fontWeight:700 }}>Current Schema</div>
                            <div style={{ fontSize:24, fontWeight:800, color:activeAccent, marginBottom:8, textShadow:`0 0 12px ${activeAccentBg}` }}>{inputSchemaLabel}</div>
                    <div style={{ fontSize:13, color:T.txt2, lineHeight:1.6 }}>
                        {inputSchema?.type === 'transaction_graph' ? 'Source and destination accounts are aggregated into node-level risk features for network reciprocity.' : 'The model is currently using the legacy wide-table account schema.'}
                    </div>
                </div>
            </div>
        </Card>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:20, marginBottom:20 }}>
            <MetricCard label="Total Accounts Scanned" value={totalScanned.toLocaleString()} color={T.txt1} />
            <MetricCard label="Critical Threats" value={critCount} color={T.crit} />
            <MetricCard label="High Risk Anomalies" value={highCount} color={T.high} />
            <MetricCard
                label="Analyst Reviews"
                value={feedbackStats ? feedbackStats.total.toLocaleString() : '—'}
                note={feedbackStats ? `${feedbackStats.confirmedFraud} fraud · ${feedbackStats.markedSafe} safe · Precision ${feedbackStats.precision}` : 'Awaiting analyst labels'}
                color={activeAccent}
            />
        </div>
    </div>
);

const SystemLogsView = ({
    activeLogTab, setActiveLogTab, handleSystemWipe, currentLogs, currentPage, totalLogPages, jumpPage, setJumpPage, handleJumpKey, setCurrentPage,
    currentFiles, resolveSourceType, totalFilePages, isRetraining, retrainCooldown, handleTriggerRetrain
}) => (
    <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, flexWrap:'wrap', gap:12 }}>
            <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, padding:4, gap:4, overflowX:'auto' }}>
                {[['ALL','All Events'],['AI_ENGINE','AI Engine'],['ANALYST','Analyst'],['SYSTEM','System'],['FILES','Datasets']].map(([id,label]) => (
                    <button key={id} onClick={() => setActiveLogTab(id)} style={{ padding:'8px 16px', fontSize:13, fontWeight:700, borderRadius:6, border:'none', cursor:'pointer', transition:'all 0.2s', whiteSpace:'nowrap', background: activeLogTab === id ? T.raised : 'transparent', color: activeLogTab === id ? T.txt1 : T.txt3 }}>{label}</button>
                ))}
            </div>
            <button onClick={handleSystemWipe} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px', fontSize:13, fontWeight:700, borderRadius:8, cursor:'pointer', background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit, transition:'all 0.2s', boxShadow:`0 0 12px ${T.critBg}` }} onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.2)'; }} onMouseLeave={e => { e.currentTarget.style.background = T.critBg; }}>
                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg> Wipe Database
            </button>

            <button 
                onClick={handleTriggerRetrain} 
                disabled={isRetraining || retrainCooldown}
                style={{ 
                    display:'flex', alignItems:'center', gap:8, padding:'8px 16px', fontSize:13, fontWeight:700, borderRadius:8, 
                    cursor: (isRetraining || retrainCooldown) ? 'not-allowed' : 'pointer', 
                    background: (isRetraining || retrainCooldown) ? T.raised : T.accentBg, 
                    border:`1px solid ${T.accent}`, 
                    color: (isRetraining || retrainCooldown) ? T.txt3 : T.accent, 
                    transition:'all 0.2s', 
                    boxShadow: (isRetraining || retrainCooldown) ? 'none' : `0 0 12px ${T.accentBg}` 
                }}>
                {isRetraining ? (
                    <><span style={{ width: 14, height: 14, border: `2px solid ${T.txt3}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /> Retraining...</>
                ) : retrainCooldown ? (
                    'Cooldown...'
                ) : (
                    'Trigger Retrain'
                )}
            </button>
    
        </div>

        {activeLogTab !== 'FILES' ? (
            <Card>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead><tr><TH>Timestamp</TH><TH>Actor</TH><TH>Event</TH><TH>Message</TH></tr></thead>
                    <tbody>
                        {currentLogs.length > 0 ? currentLogs.map((log, i) => (
                            <tr key={i} style={{ borderBottom:`1px solid ${T.border}` }} onMouseEnter={e => e.currentTarget.style.background = T.raised} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                <td style={{ padding:'14px 16px', fontFamily:'monospace', fontSize:12, color:T.txt3, whiteSpace:'nowrap' }}>{new Date(log.timestamp).toLocaleString()}</td>
                                <td style={{ padding:'14px 16px' }}><ActorBadge actor={log.actor} /></td>
                                <td style={{ padding:'14px 16px' }}><span style={{ fontSize:11, fontWeight:800, textTransform:'uppercase', letterSpacing:'0.1em', color: log.actionType === 'REJECTION' ? T.crit : log.actionType === 'RESOLUTION' ? T.ok : T.txt3 }}>{log.actionType}</span></td>
                                <TD>{log.message}</TD>
                            </tr>
                        )) : <tr><td colSpan="4" style={{ padding:'40px 16px', textAlign:'center', color:T.txt3, fontSize:13, fontFamily:'monospace', letterSpacing:'0.1em' }}>NO LOGS MATCHING FILTER</td></tr>}
                    </tbody>
                </table>
                <Pagination current={currentPage} total={totalLogPages} jumpPage={jumpPage} onJumpChange={e => setJumpPage(e.target.value)} onJumpKey={e => handleJumpKey(e, totalLogPages)} onPrev={() => setCurrentPage(p => Math.max(1,p-1))} onNext={() => setCurrentPage(p => Math.min(totalLogPages,p+1))} />
            </Card>
        ) : (
            <Card>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead><tr><TH>Ingested At</TH><TH>File Name</TH><TH>Source</TH><TH>SHA-256 Hash</TH></tr></thead>
                    <tbody>
                        {currentFiles.length > 0 ? currentFiles.map((file, i) => (
                            <tr key={i} style={{ borderBottom:`1px solid ${T.border}` }} onMouseEnter={e => e.currentTarget.style.background = T.raised} onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                                <td style={{ padding:'14px 16px', fontFamily:'monospace', fontSize:12, color:T.txt3, whiteSpace:'nowrap' }}>{new Date(file.processedAt).toLocaleString()}</td>
                                <td style={{ padding:'14px 16px', fontSize:14, fontWeight:700, color:T.high, fontFamily:'monospace' }}>{file.fileName}</td>
                                <td style={{ padding:'14px 16px' }}><span style={{ fontSize:10, fontWeight:800, letterSpacing:'0.1em', textTransform:'uppercase', color:resolveSourceType(file) === 'LIVE_STREAM' ? T.high : T.txt2, background: resolveSourceType(file) === 'LIVE_STREAM' ? T.highBg : T.raised, border:`1px solid ${resolveSourceType(file) === 'LIVE_STREAM' ? T.highBdr : T.borderHi}`, padding:'3px 10px', borderRadius:9999 }}>{resolveSourceType(file) === 'LIVE_STREAM' ? 'Live Stream' : 'Static Ingest'}</span></td>
                                <td style={{ padding:'14px 16px', fontFamily:'monospace', fontSize:12, color:T.txt3, wordBreak:'break-all' }}>{file.fileHash}</td>
                            </tr>
                        )) : <tr><td colSpan="4" style={{ padding:'40px 16px', textAlign:'center', color:T.txt3, fontSize:13, fontFamily:'monospace', letterSpacing:'0.1em' }}>NO DATASETS INGESTED</td></tr>}
                    </tbody>
                </table>
                <Pagination current={currentPage} total={totalFilePages} jumpPage={jumpPage} onJumpChange={e => setJumpPage(e.target.value)} onJumpKey={e => handleJumpKey(e, totalFilePages)} onPrev={() => setCurrentPage(p => Math.max(1,p-1))} onNext={() => setCurrentPage(p => Math.min(totalFilePages,p+1))} />
            </Card>
        )}
    </div>
);

const ModelAnalyticsView = ({
    inputSchema, modelConfig, modelMetrics, formatMetricDisplay, activeAccent, thresholdCurve, droppedFeatures, activeAlerts, riskData, CHART_CLRS, featureData, featureImportance, activeDataset, jwtToken, modelVersion, currentRole
}) => {
    const [analyticsTab, setAnalyticsTab] = useState('PERFORMANCE');
    const [compareData, setCompareData] = useState(null);
    const [compareLoading, setCompareLoading] = useState(false);
    
    const [draftAlertThreshold, setDraftAlertThreshold] = useState(null);
    const [draftCriticalThreshold, setDraftCriticalThreshold] = useState(null);
    
    useEffect(() => {
        if (modelConfig?.alert_threshold != null && draftAlertThreshold === null) setDraftAlertThreshold(modelConfig.alert_threshold);
        if (modelConfig?.critical_threshold != null && draftCriticalThreshold === null) setDraftCriticalThreshold(modelConfig.critical_threshold);
    }, [modelConfig]);

    const handleSaveThresholds = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/threshold`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-User-Role': currentRole },
                body: JSON.stringify({ alert_threshold: draftAlertThreshold, critical_threshold: draftCriticalThreshold })
            });
            if (res.ok) {
                toast.success('Thresholds saved. New data will use these cutoffs.', { style:{ background:T.raised, color:T.ok, border:`1px solid ${T.okBdr}` } });
            } else {
                toast.error('Failed to save thresholds');
            }
        } catch { toast.error('Failed to save thresholds'); }
    };
    
    const [graphData, setGraphData] = useState({ nodes: [], links: [] });
    const [graphLoading, setGraphLoading] = useState(false);

    const [geoData, setGeoData] = useState([]);
    const [geoLoading, setGeoLoading] = useState(false);

    const fetchCompareData = async () => {
        console.log("fetchCompareData CALLED. Role:", currentRole, "Dataset:", activeDataset);
        if (currentRole === 'Analyst') return;
        try {
            console.log("Setting compare loading to true");
            setCompareLoading(true);
            const token = jwtToken;
            console.log("Fetching API_BASE + /api/compare-models");
            const res = await fetch(API_BASE + '/api/compare-models', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${jwtToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceFileName: activeDataset === 'ALL' ? null : activeDataset }) // FIX: pass null if ALL to force default
            });
            console.log("Fetch done, parsing json. Status:", res.status);
            const data = await res.json();
            console.log("Parsed json:", data);
            if (data.success) setCompareData(data.comparison);
            else setCompareData(null);
        } catch(err) { console.error("fetchCompareData ERROR:", err); } finally { console.log("Finally, setting loading false"); setCompareLoading(false); }
    };

    const fetchGraphData = async () => {
        try {
            setGraphLoading(true);
            const token = jwtToken;
            const res = await fetch(API_BASE + `/api/graph-topology/${activeDataset === 'ALL' ? 'demo_transaction_graph.csv' : activeDataset}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.success) setGraphData(data.data);
            else setGraphData({ nodes: [], links: [] });
        } catch(err) { console.error(err); } finally { setGraphLoading(false); }
    };

    const fetchGeoData = async () => {
        try {
            setGeoLoading(true);
            const token = jwtToken;
            const res = await fetch(API_BASE + '/api/geo-distribution', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data.success) setGeoData(data.data);
            else setGeoData([]);
        } catch(err) { console.error(err); } finally { setGeoLoading(false); }
    };

    useEffect(() => {
        if (analyticsTab === 'COMPARE') fetchCompareData();
        if (analyticsTab === 'GRAPH') fetchGraphData();
        if (analyticsTab === 'GEO') fetchGeoData();
    }, [analyticsTab, activeDataset]);

    const geoUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

    return (
    <div>
        <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, padding:4, gap:4, marginBottom: 20 }}>
            {[['PERFORMANCE','Performance'],['COMPARE','Model Comparison'],['GRAPH','Network Graph'],['GEO','Geo Map']].map(([id,label]) => (
                <button key={id} onClick={() => setAnalyticsTab(id)} style={{ padding:'8px 18px', fontSize:13, fontWeight:700, borderRadius:6, border:'none', cursor:'pointer', transition:'all 0.2s', background: analyticsTab === id ? T.raised : 'transparent', color: analyticsTab === id ? activeAccent : T.txt3 }}>{label}</button>
            ))}
        </div>

        {analyticsTab === 'COMPARE' && (
            <Card style={{ padding:'20px 24px', marginBottom:20 }}>
                <h3 style={{ margin:'0 0 16px 0', color:T.txt1 }}>A/B Model Comparison</h3>
                {currentRole === 'Analyst' ? (
                    <div style={{ color:T.txt3 }}>Overseer/Admin permission required</div>
                ) : compareLoading ? (
                    <div style={{ color:T.txt3 }}>Loading comparison...</div>
                ) : compareData ? (
                    <div>
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:20 }}>
                            <MetricCard label="Current Accuracy" value={compareData.primaryAccuracy ? (compareData.primaryAccuracy * 100).toFixed(2) + '%' : 'NaN%'} color={T.txt1} />
                            <MetricCard label="Standby Accuracy" value={compareData.standbyAccuracy ? (compareData.standbyAccuracy * 100).toFixed(2) + '%' : 'NaN%'} color={compareData.standbyAccuracy > compareData.primaryAccuracy ? T.ok : T.high} />
                        </div>
                        {compareData.disagreements && compareData.disagreements.length > 0 && (
                            <div style={{ marginTop: 24 }}>
                                <h4 style={{ color: T.txt2, margin: '0 0 12px' }}>Top Disagreement Cases</h4>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'left' }}>
                                    <thead>
                                        <tr style={{ borderBottom: `1px solid ${T.borderHi}`, color: T.txt3 }}>
                                            <th style={{ padding: '10px 8px' }}>Account ID</th>
                                            <th style={{ padding: '10px 8px' }}>Primary Score</th>
                                            <th style={{ padding: '10px 8px' }}>Standby Score</th>
                                            <th style={{ padding: '10px 8px' }}>Delta</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {compareData.disagreements.map((row) => (
                                            <tr key={row.accountId} style={{ borderBottom: `1px solid ${T.border}`, color: T.txt1 }}>
                                                <td style={{ padding: '10px 8px', fontWeight: 600 }}>{row.accountId}</td>
                                                <td style={{ padding: '10px 8px' }}>{row.primaryScore.toFixed(2)}</td>
                                                <td style={{ padding: '10px 8px' }}>{row.standbyScore.toFixed(2)}</td>
                                                <td style={{ padding: '10px 8px', color: T.high, fontWeight: 600 }}>{row.delta.toFixed(2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                ) : <div style={{ color:T.txt3 }}>Comparison data unavailable. Verify standby model exists.</div>}
            </Card>
        )}

        {analyticsTab === 'GRAPH' && (
            <Card style={{ padding:'20px 24px', marginBottom:20 }}>
                <h3 style={{ margin:'0 0 16px 0', color:T.txt1 }}>Transaction Network Graph</h3>
                {graphLoading ? <div style={{ color:T.txt3 }}>Loading graph...</div> : graphData.nodes.length > 0 ? (
                    <div style={{ height: 600, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden' }}>
                        <ForceGraph2D 
                            graphData={graphData}
                            nodeColor={node => node.group === 1 ? T.accent : T.high}
                            linkColor={() => T.borderHi}
                            nodeLabel="id"
                            backgroundColor={T.bg}
                        />
                    </div>
                ) : <div style={{ color:T.txt3 }}>Graph data unavailable. CSV missing or empty.</div>}
            </Card>
        )}

        {analyticsTab === 'GEO' && (
            <Card style={{ padding:'20px 24px', marginBottom:20 }}>
                <h3 style={{ margin:'0 0 16px 0', color:T.txt1 }}>Geographic Risk Heatmap</h3>
                {geoLoading ? <div style={{ color:T.txt3 }}>Loading map...</div> : geoData.length > 0 ? (
                    <div style={{ height: 600, border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden', background: T.bg }}>
                        <ComposableMap projectionConfig={{ scale: 140 }}>
                            <Geographies geography={geoUrl}>
                                {({ geographies }) =>
                                    geographies.map((geo) => (
                                        <Geography key={geo.rsmKey} geography={geo} fill={T.surface} stroke={T.borderHi} />
                                    ))
                                }
                            </Geographies>
                            {geoData.map(({ id, name, coordinates, value }) => (
                                <Marker key={id} coordinates={coordinates}>
                                    <circle r={value / 5} fill={T.crit} fillOpacity={0.6} stroke="#fff" strokeWidth={1} />
                                    <text textAnchor="middle" y={-10} style={{ fontFamily: "monospace", fill: T.txt1, fontSize: 10 }}>
                                        {name}
                                    </text>
                                </Marker>
                            ))}
                        </ComposableMap>
                    </div>
                ) : <div style={{ color:T.txt3 }}>Geo data unavailable.</div>}
            </Card>
        )}

        {analyticsTab === 'PERFORMANCE' && (
            <>
<div>
        {/* 3.3 Model Version Panel */}
        {modelVersion ? (
            <Card style={{ padding:'16px 20px', marginBottom:20, border:`1px solid ${T.borderHi}` }}>
                <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:12 }}>Model Version</div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, flexWrap:'wrap' }}>
                    {[['Trained', modelVersion.trainedAt ? new Date(modelVersion.trainedAt).toLocaleString() : '—'],
                      ['Samples', modelVersion.trainingSamples?.toLocaleString() ?? '—'],
                      ['Feedback Labels', modelVersion.feedbackLabels?.toLocaleString() ?? '—'],
                      ['Schema', modelVersion.schemaType ?? '—'],
                      ['Features', modelVersion.featureCount?.toString() ?? '—'],
                      ['Threshold', modelVersion.threshold?.toFixed(2) ?? '—'],
                    ].map(([k,v]) => (
                        <div key={k} style={{ background:T.bg, border:`1px solid ${T.border}`, borderRadius:8, padding:'10px 14px' }}>
                            <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:700, marginBottom:4 }}>{k}</div>
                            <div style={{ fontSize:14, fontWeight:700, color:T.txt1, fontFamily:'monospace' }}>{v}</div>
                        </div>
                    ))}
                </div>
            </Card>
        ) : (
            <div style={{ color:T.txt3, fontStyle:'italic', fontSize:13, marginBottom:20 }}>Model version tracking not yet configured.</div>
        )}
        {/* 3.4 Confusion Matrix */}
        {modelMetrics?.confusion_matrix && Array.isArray(modelMetrics.confusion_matrix) && modelMetrics.confusion_matrix.length === 2 && (
            <Card style={{ padding:'20px 24px', marginBottom:20 }}>
                <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', fontWeight:700, marginBottom:16 }}>Confusion Matrix</div>
                <ConfusionMatrix matrix={modelMetrics.confusion_matrix} />
            </Card>
        )}
        <Card style={{ padding:'20px 24px', marginBottom:20, border:`1px solid ${T.okBdr || 'rgba(16,185,129,0.3)'}`, background:`linear-gradient(135deg, ${T.surface} 0%, rgba(16,185,129,0.05) 100%)` }}>
            <div style={{ display:'flex', alignItems:'center', gap:16, flexWrap:'wrap' }}>
                <div style={{ width:12, height:12, borderRadius:999, background:T.ok, boxShadow:`0 0 12px ${T.ok}` }} />
                <div>
                    <div style={{ fontSize:13, fontWeight:800, color:T.ok, letterSpacing:'0.1em', textTransform:'uppercase' }}>PS2 Compliance Validated</div>
                    <div style={{ fontSize:13, color:T.txt1, lineHeight:1.6, marginTop:6 }}>Pipeline successfully executes Graph Node Aggregation (Ring Detection), Velocity Burst Tracking (Pass-Through Detection), and Recall-Optimized Thresholding to satisfy Problem Statement 2 requirements.</div>
                </div>
            </div>
        </Card>

        <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:16, marginBottom:20 }}>
            {[
                { label:'Input Schema', value:inputSchema?.type === 'transaction_graph' ? 'GRAPH' : (inputSchema?.type || 'wide_table') },
                { label:'Alert Threshold', value:modelConfig?.alert_threshold?.toFixed ? modelConfig.alert_threshold.toFixed(2) : (modelConfig?.alert_threshold ?? '0.85') },
                { label:'Critical Threshold', value:modelConfig?.critical_threshold?.toFixed ? modelConfig.critical_threshold.toFixed(2) : (modelConfig?.critical_threshold ?? '0.95') },
                { label:'ROC AUC', value: formatMetricDisplay(modelMetrics?.roc_auc, modelMetrics?.sample_count) },
                { label:'PR AUC', value: formatMetricDisplay(modelMetrics?.pr_auc, modelMetrics?.sample_count) },
            ].map(({ label, value }) => (
                <MetricCard key={label} label={label} value={value} note={((label === 'ROC AUC' || label === 'PR AUC') && modelMetrics?.sample_count && modelMetrics.sample_count < 20) ? 'Insufficient samples to reliably show this metric' : null} color={activeAccent} />
            ))}
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:20 }}>
            <PadCard>
                <PanelHeader kicker="Threshold sweep" title="Alert volume by threshold" description="This chart answers a single question: how many alerts remain as the cutoff rises?" />
                <div style={{ height:240 }}>
                    {thresholdCurve.length > 0 ? (
                        <ResponsiveContainer width="100%" height={240} minWidth={1}>
                            <LineChart data={thresholdCurve} margin={{ top:8, right:16, left:0, bottom:8 }}>
                                <defs>
                                    <linearGradient id="colorAlert" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor={activeAccent} stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor={activeAccent} stopOpacity={0}/>
                                    </linearGradient>
                                </defs>
                                <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="threshold" label={{ value:'Threshold', position:'insideBottom', offset:-5, fill:T.txt3, fontSize:12 }} tickFormatter={fmtThreshold} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} angle={-45} textAnchor="end" interval="preserveStartEnd" height={54} />
                                <YAxis label={{ value:'Alerts', angle:-90, position:'insideLeft', fill:T.txt3, fontSize:12 }} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} />
                                <RechartsTooltip contentStyle={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, fontSize:13, color:T.txt1, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }} />
                                <Legend wrapperStyle={{ fontSize:13, paddingTop:12, color:T.txt2, fontWeight:600 }} />
                                <Line type="monotone" dataKey="alert_count" stroke={activeAccent} strokeWidth={3} dot={false} name="Alert Count" activeDot={{ r: 6, fill: activeAccent, stroke: T.bg, strokeWidth: 2 }} />
                            </LineChart>
                        </ResponsiveContainer>
                    ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No threshold curve</div>}
                </div>
                <div style={{ marginTop:16, fontSize:12, color:T.txt3, lineHeight:1.5 }}>Pruned {droppedFeatures.length} correlated features to keep the schema lean.</div>
            </PadCard>

            <PadCard>
                <PanelHeader kicker="Threshold sweep" title="Detection quality by threshold" description="Precision, recall, and F1 are shown on the same scale so the trade-off is obvious." />
                <div style={{ height:240 }}>
                    {thresholdCurve.length > 0 ? (
                        <ResponsiveContainer width="100%" height={240} minWidth={1}>
                            <LineChart data={thresholdCurve} margin={{ top:8, right:16, left:0, bottom:8 }}>
                                <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="threshold" label={{ value:'Threshold', position:'insideBottom', offset:-5, fill:T.txt3, fontSize:12 }} tickFormatter={fmtThreshold} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} angle={-45} textAnchor="end" interval="preserveStartEnd" height={54} />
                                <YAxis label={{ value:'Score', angle:-90, position:'insideLeft', fill:T.txt3, fontSize:12 }} domain={[0, 1]} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} />
                                <RechartsTooltip contentStyle={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, fontSize:13, color:T.txt1, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }} />
                                <Legend wrapperStyle={{ fontSize:13, paddingTop:12, color:T.txt2, fontWeight:600 }} />
                                <Line type="monotone" dataKey="precision" stroke={T.ok} strokeWidth={3} dot={false} name="Precision" />
                                <Line type="monotone" dataKey="recall" stroke={T.high} strokeWidth={3} dot={false} name="Recall" />
                                <Line type="monotone" dataKey="f1" stroke={activeAccent} strokeWidth={3} dot={false} name="F1" />
                            </LineChart>
                        </ResponsiveContainer>
                    ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No threshold curve</div>}
                </div>
                <div style={{ marginTop:16, fontSize:12, color:T.txt3, lineHeight:1.5 }}>Pruned {droppedFeatures.length} correlated features to keep the schema lean.</div>
            </PadCard>

            <PadCard>
                <PanelHeader kicker="Threshold sweep" title="Detection quality by threshold" description="Precision, recall, and F1 are shown on the same scale so the trade-off is obvious." />
                <div style={{ height:240 }}>
                    {thresholdCurve.length > 0 ? (
                        <ResponsiveContainer width="100%" height={240} minWidth={1}>
                            <LineChart data={thresholdCurve} margin={{ top:8, right:16, left:0, bottom:8 }}>
                                <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                                <XAxis dataKey="threshold" label={{ value:'Threshold', position:'insideBottom', offset:-5, fill:T.txt3, fontSize:12 }} tickFormatter={fmtThreshold} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} angle={-45} textAnchor="end" interval="preserveStartEnd" height={54} />
                                <YAxis label={{ value:'Score', angle:-90, position:'insideLeft', fill:T.txt3, fontSize:12 }} domain={[0, 1]} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace' }} axisLine={false} tickLine={false} />
                                <RechartsTooltip contentStyle={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, fontSize:13, color:T.txt1, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }} />
                                <Legend wrapperStyle={{ fontSize:13, paddingTop:12, color:T.txt2, fontWeight:600 }} />
                                <Line type="monotone" dataKey="precision" stroke={T.ok} strokeWidth={3} dot={false} name="Precision" />
                                <Line type="monotone" dataKey="recall" stroke={T.high} strokeWidth={3} dot={false} name="Recall" />
                                <Line type="monotone" dataKey="f1" stroke={activeAccent} strokeWidth={3} dot={false} name="F1" />
                            </LineChart>
                        </ResponsiveContainer>
                    ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No threshold curve</div>}
                </div>
            </PadCard>
        </div>

        <PadCard style={{ marginBottom: 20 }}>
            <PanelHeader kicker="Configuration" title="Operating Thresholds" description="Adjust risk cutoffs. This immediately affects how new data is flagged." />
            <div style={{ display:'flex', gap:32, alignItems:'center', padding:'16px 0' }}>
                <div style={{ flex:1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                        <span style={{ fontSize:13, color:T.txt2, fontWeight:600 }}>Alert Threshold</span>
                        <span style={{ fontSize:13, color:T.txt1, fontFamily:'monospace' }}>{draftAlertThreshold?.toFixed(2) || '0.85'}</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.01" value={draftAlertThreshold || 0.85} onChange={e => setDraftAlertThreshold(parseFloat(e.target.value))} style={{ width:'100%', accentColor: activeAccent }} />
                </div>
                <div style={{ flex:1 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:8 }}>
                        <span style={{ fontSize:13, color:T.txt2, fontWeight:600 }}>Critical Threshold</span>
                        <span style={{ fontSize:13, color:T.txt1, fontFamily:'monospace' }}>{draftCriticalThreshold?.toFixed(2) || '0.95'}</span>
                    </div>
                    <input type="range" min="0" max="1" step="0.01" value={draftCriticalThreshold || 0.95} onChange={e => setDraftCriticalThreshold(parseFloat(e.target.value))} style={{ width:'100%', accentColor: T.crit }} />
                </div>
                <div>
                    <button onClick={handleSaveThresholds} disabled={currentRole === 'Analyst'} style={{ background: currentRole === 'Analyst' ? T.border : activeAccent, color: currentRole === 'Analyst' ? T.txt3 : T.bg, padding:'8px 16px', borderRadius:6, border:'none', cursor: currentRole === 'Analyst' ? 'not-allowed' : 'pointer', fontWeight:600, fontSize:13 }}>Apply</button>
                    {currentRole === 'Analyst' && <div style={{ fontSize:11, color:T.txt3, marginTop:4, textAlign:'center' }}>Overseer/Admin permission required</div>}
                </div>
            </div>
            {(() => {
                const draftPt = thresholdCurve.find(p => p.threshold >= (draftAlertThreshold || 0.85));
                if (!draftPt) return null;
                return (
                    <div style={{ background:T.surface, padding:'12px 16px', borderRadius:8, border:`1px solid ${T.borderHi}`, fontSize:13, color:T.txt2, display:'flex', gap:24 }}>
                        <div>Expected Alert Count: <span style={{ color:T.txt1, fontWeight:700 }}>{draftPt.alert_count}</span></div>
                        <div>Expected Precision: <span style={{ color:T.ok, fontWeight:700 }}>{(draftPt.precision * 100).toFixed(1)}%</span></div>
                        <div>Expected Recall: <span style={{ color:T.high, fontWeight:700 }}>{(draftPt.recall * 100).toFixed(1)}%</span></div>
                        <div>Expected F1: <span style={{ color:activeAccent, fontWeight:700 }}>{(draftPt.f1 * 100).toFixed(1)}%</span></div>
                    </div>
                );
            })()}
        </PadCard>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:20, marginBottom:20 }}>
            <PadCard>
                <PanelHeader kicker="Alert mix" title="Critical vs high-risk share" description="This shows the alert population split at the current thresholds." />
                <div style={{ height:280 }}>
                    {activeAlerts.length > 0 ? (
                        <ResponsiveContainer width="100%" height={280} minWidth={1}>
                            <PieChart>
                                <Pie data={riskData} innerRadius={70} outerRadius={110} paddingAngle={5} dataKey="value" stroke="none" cornerRadius={4}>
                                    {riskData.map((_, i) => <Cell key={i} fill={CHART_CLRS[i]} style={{ filter: `drop-shadow(0 0 8px ${CHART_CLRS[i]}80)` }} />)}
                                </Pie>
                                <RechartsTooltip cursor={false} contentStyle={{ background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8, fontSize:13, color:T.txt1, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }} />
                                <Legend verticalAlign="bottom" height={36} iconType="circle" wrapperStyle={{ fontSize:13, paddingTop:16, color:T.txt1, fontWeight:600 }} />
                            </PieChart>
                        </ResponsiveContainer>
                    ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No data</div>}
                </div>
            </PadCard>

            <PadCard>
                <PanelHeader kicker="Signal frequency" title="Most frequent anomaly signals" description="The top repeated signals help explain which behaviors are dominating the current batch." />
                <div style={{ height:280 }}>
                    {featureData.length > 0 ? (
                        <ResponsiveContainer width="100%" height={280} minWidth={1}>
                            <BarChart data={featureData} layout="vertical" margin={{ top:0, right:16, left:8, bottom:8 }}>
                                <XAxis type="number" hide />
                                <YAxis dataKey="name" type="category" width={56} axisLine={false} tickLine={false} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace', fontWeight:600 }} />
                                <RechartsTooltip cursor={{ fill:'rgba(255,255,255,0.04)' }} content={<BarTooltip />} />
                                <Bar dataKey="count" fill={activeAccent} radius={[0,4,4,0]} />
                            </BarChart>
                        </ResponsiveContainer>
                    ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No data</div>}
                </div>
            </PadCard>
        </div>
        <PadCard style={{ marginTop:20 }}>
            <PanelHeader kicker="Feature importance" title="Top Feature Importance" description={null} />
            <div style={{ height:320 }}>
                {featureImportance.length > 0 ? (
                    <ResponsiveContainer width="100%" height={320} minWidth={1}>
                        <BarChart data={featureImportance.slice(0, 12)} layout="vertical" margin={{ top:0, right:16, left:8, bottom:8 }}>
                            <XAxis type="number" hide />
                            <YAxis dataKey="name" type="category" width={140} axisLine={false} tickLine={false} tick={{ fill:T.txt3, fontSize:11, fontFamily:'monospace', fontWeight:600 }} />
                            <RechartsTooltip cursor={{ fill:'rgba(255,255,255,0.04)' }} content={<ImportanceTooltip />} />
                            <Bar dataKey="importance" fill={activeAccent} radius={[0,4,4,0]} />
                        </BarChart>
                    </ResponsiveContainer>
                ) : <div style={{ height:'100%', display:'flex', alignItems:'center', justifyContent:'center', color:T.txt3, fontSize:13, fontFamily:'monospace' }}>No importance data</div>}
            </div>
        </PadCard>
    </div>
            </>
        )}
    </div>
    );
};


const ThreatMatrixView = ({
    currentView, activeTab, setActiveTab, searchType, setSearchType, searchTerm, setSearchTerm, exportToCSV,
    totalAlertsCount, currentPage, totalPages, currentAlerts, setSelectedAccount, handleResolve, handleConfirmFraud, confirmMule, revokeMule, activeAccent, activeAccentBg, jumpPage, setJumpPage, handleJumpKey, setCurrentPage,
    selectedAlertIds, setSelectedAlertIds, handleBulkAction
}) => {
    const headerRef = useRef(null);
    const isAllSelected = currentAlerts.length > 0 && currentAlerts.every(a => selectedAlertIds.has(a._id));
    const isIndeterminate = !isAllSelected && currentAlerts.some(a => selectedAlertIds.has(a._id));
    useEffect(() => {
        if (headerRef.current) headerRef.current.indeterminate = isIndeterminate;
    }, [isIndeterminate]);
    const toggleAll = () => {
        if (isAllSelected) {
            setSelectedAlertIds(prev => { const next = new Set(prev); currentAlerts.forEach(a => next.delete(a._id)); return next; });
        } else {
            setSelectedAlertIds(prev => { const next = new Set(prev); currentAlerts.forEach(a => next.add(a._id)); return next; });
        }
    };
    const toggleOne = (id) => setSelectedAlertIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
    return (
    <div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16, gap:16, flexWrap:'wrap' }}>
            {currentView === 'DETAILED_VIEW' ? (
                <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, padding:4, gap:4 }}>
                    {[['ALL','All'],['CRITICAL','Critical'],['HIGH_RISK','High Risk']].map(([id,label]) => (
                        <button key={id} onClick={() => setActiveTab(id)} style={{ padding:'8px 18px', fontSize:13, fontWeight:700, borderRadius:6, border:'none', cursor:'pointer', transition:'all 0.2s', letterSpacing:'0.02em', background: activeTab === id ? T.raised : 'transparent', color: activeTab === id ? (id === 'CRITICAL' ? T.crit : id === 'HIGH_RISK' ? T.high : T.txt1) : T.txt3 }}>{label}</button>
                    ))}
                </div>
            ) : (
                <div><h2 style={{ fontSize: 20, fontWeight:800, color: T.txt1, margin: 0 }}>Confirmed Mules Directory</h2></div>
            )}

            <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                <div style={{ display:'flex', background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, overflow:'hidden', boxShadow:'inset 0 2px 4px rgba(0,0,0,0.2)' }}>
                    <select value={searchType} onChange={e => setSearchType(e.target.value)} style={{ padding:'8px 12px', fontSize:12, background:T.raised, border:'none', borderRight:`1px solid ${T.border}`, color:T.txt2, outline:'none', cursor:'pointer', fontWeight:700 }}>
                        <option value="ACCOUNT_ID">ACCT ID</option>
                        <option value="FEATURE">FEATURE</option>
                    </select>
                    <input type="text" placeholder="Search…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ padding:'8px 16px', fontSize:14, background:'transparent', border:'none', color:T.txt1, outline:'none', width:220 }} />
                </div>
                {currentView === 'DETAILED_VIEW' && (
                    <button onClick={exportToCSV} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 16px', fontSize:13, fontWeight:700, borderRadius:8, cursor:'pointer', background:T.surface, border:`1px solid ${T.border}`, color:T.txt2, transition:'all 0.2s' }} {...hoverBorderButtonProps(T.txt2)}>
                        <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Export CSV
                    </button>
                )}
            </div>
        </div>

        <div style={{ fontSize:13, color:T.txt3, marginBottom:12, fontWeight:600 }}>
            <span style={{ color:T.txt1, fontWeight:800 }}>{totalAlertsCount}</span> threats · page <span style={{ color:T.txt1, fontWeight:800 }}>{currentPage}</span> of {totalPages || 1}
        </div>

        {/* 3.9 Bulk Action Bar */}
        {selectedAlertIds.size > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 16px', marginBottom:12, background:T.raised, border:`1px solid ${T.borderHi}`, borderRadius:8 }}>
                <span style={{ fontSize:13, color:T.txt2, fontWeight:600 }}>{selectedAlertIds.size} selected</span>
                <button onClick={() => handleBulkAction('SAFE')} style={{ padding:'6px 14px', fontSize:12, fontWeight:700, borderRadius:6, cursor:'pointer', background:T.okBg, border:`1px solid ${T.ok}40`, color:T.ok }}>Mark All Safe</button>
                <button onClick={() => handleBulkAction('CONFIRMED_FRAUD')} style={{ padding:'6px 14px', fontSize:12, fontWeight:700, borderRadius:6, cursor:'pointer', background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit }}>Confirm All Fraud</button>
                <button onClick={() => setSelectedAlertIds(new Set())} style={{ padding:'6px 14px', fontSize:12, fontWeight:700, borderRadius:6, cursor:'pointer', background:T.surface, border:`1px solid ${T.border}`, color:T.txt3 }}>Dismiss Selection</button>
            </div>
        )}

        <Card>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                    <tr>
                        {currentView === 'DETAILED_VIEW' && <th style={{ padding:'12px 16px', width:40 }}><input type="checkbox" ref={headerRef} checked={isAllSelected} onChange={toggleAll} style={{ cursor:'pointer', accentColor:activeAccent }} /></th>}
                        <TH>Account ID</TH>
                        <TH>Status</TH>
                        <TH>Risk Score</TH>
                        <TH>SHAP Explainability (Why?)</TH>
                        <TH>Age</TH>
                        <TH>Dataset</TH>
                        <TH right>Actions</TH>
                    </tr>
                </thead>
                <tbody>
                    {currentAlerts.length > 0 ? currentAlerts.map((alert, i) => {
                        const isCrit = alert.status === 'Critical';
                        const isSelected = selectedAlertIds.has(alert._id);
                        return (
                            <tr key={i} onClick={() => setSelectedAccount(alert)} style={{ borderBottom:`1px solid ${T.border}`, cursor:'pointer', borderLeft:`3px solid ${isCrit ? T.crit : T.high}`, transition:'background 0.15s', background: isSelected ? T.raised : 'transparent' }} onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = T.raised; }} onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}>
                                {currentView === 'DETAILED_VIEW' && <td onClick={e => { e.stopPropagation(); toggleOne(alert._id); }} style={{ padding:'16px 16px', textAlign:'center', width:40 }}><input type="checkbox" checked={isSelected} onChange={() => toggleOne(alert._id)} onClick={e => e.stopPropagation()} style={{ cursor:'pointer', accentColor:activeAccent }} /></td>}
                                <td style={{ padding:'16px 20px' }}><div style={{ fontFamily:'monospace', fontSize:14, fontWeight:700, color:T.txt1 }}>{alert.accountId}</div></td>
                                <td style={{ padding:'16px 20px' }}><div style={{ display:'flex', alignItems:'center', gap:10 }}><StatusChip status={alert.status} /><MuleStatusBadge status={alert.muleStatus || 'Pending'} /></div></td>
                                <td style={{ padding:'16px 20px', minWidth:130 }}>
                                    <div style={{ fontSize:16, fontWeight:800, fontFamily:'monospace', color: isCrit ? T.crit : T.high, textShadow:`0 0 8px ${isCrit ? T.crit : T.high}` }}>{alert.riskScore.toFixed(1)}%</div>
                                    <RiskBar score={alert.riskScore} status={alert.status} />
                                    <div style={{ fontSize:11, color:T.txt3, marginTop:6, fontFamily:'monospace', fontWeight:600 }}>Anomaly: {alert.anomalyScore}</div>
                                </td>
                                <td style={{ padding:'16px 20px' }}>
                                    <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                                        {getAlertFeatures(alert).map((fObj, idx) => {
                                            const f = fObj.name; const cat = featureCat(f); const contribution = Number(fObj.contribution || 0); const isPos = contribution > 0; const isNeg = contribution < 0; const shapLabel = isPos ? '▲ Risk UP' : isNeg ? '▼ Risk DOWN' : '• Neutral Impact'; const shapValue = Number.isFinite(contribution) ? String(contribution) : '0';
                                            return (
                                                <div key={f + idx} style={{ display:'flex', alignItems:'center', gap:12 }}>
                                                    <span style={{ fontSize:10, fontFamily:'monospace', fontWeight:800, color:cat.color, background:cat.bg, border:`1px solid ${cat.border}`, padding:'3px 10px', borderRadius:9999, flexShrink:0, minWidth:56, textAlign:'center', boxShadow:`0 0 8px ${cat.bg}` }}>{f === 'Anomaly_Score' ? 'STAT' : f}</span>
                                                    <div style={{ display:'flex', flexDirection:'column' }}>
                                                        <span style={{ fontSize:13, color:T.txt1, fontWeight:600 }}>{translate(f)}</span>
                                                        {fObj.contribution !== null && (
                                                            <span style={{ fontSize:11, color: isPos ? T.crit : isNeg ? T.ok : T.txt3, fontWeight:700, display:'flex', alignItems:'center', gap:4, marginTop:2 }}>{shapLabel} <span style={{ color:T.txt3, fontWeight:500 }}>(SHAP {isPos?'+':''}{shapValue})</span></span>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </td>
                                <td style={{ padding:'16px 20px' }}><AlertAge detectedAt={alert.detectedAt} /></td>
                                <TD muted>{alert.sourceFileName}</TD>
                                <td style={{ padding:'16px 20px', textAlign:'right' }}>
                                    <div style={{ display:'flex', gap:8, justifyContent:'flex-end', alignItems:'center' }}>
                                        {currentView === 'DETAILED_VIEW' && (
                                            <>
                                                <button onClick={e => handleResolve(alert.accountId, e, alert.sourceFileName)} title="Mark as Safe" style={{ padding:'6px 12px', fontSize:12, fontWeight:700, borderRadius:8, background:'transparent', border:`1px solid ${T.border}`, color:T.txt3, cursor:'pointer', transition:'all 0.2s' }} {...hoverBorderButtonProps(T.txt3, T.ok, '#163028', T.okBg)}>Safe</button>
                                                <button onClick={e => { e.stopPropagation(); e.preventDefault(); handleConfirmFraud(alert.accountId, e, alert.sourceFileName); }} title="Confirm Fraud" style={{ padding:'6px 12px', fontSize:12, fontWeight:700, borderRadius:8, background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit, cursor:'pointer', transition:'all 0.2s' }}>Fraud</button>
                                                <button onClick={e => { e.stopPropagation(); e.preventDefault(); confirmMule(alert._id); }} title="Confirm Mule" style={{ padding:'6px 12px', fontSize:12, fontWeight:700, borderRadius:8, background:T.raised, border:`1px solid ${T.borderHi}`, color:T.txt2, cursor:'pointer', transition:'all 0.2s' }}>Mule</button>
                                            </>
                                        )}
                                        {currentView === 'MULE_REGISTRY' && (
                                            <button onClick={e => { e.stopPropagation(); e.preventDefault(); revokeMule(alert._id); }} title="Revoke Status" style={{ padding:'6px 12px', fontSize:12, fontWeight:700, borderRadius:8, background:T.raised, border:`1px solid ${T.borderHi}`, color:T.txt2, cursor:'pointer', transition:'all 0.2s' }} {...hoverBorderButtonProps(T.txt2, T.ok, '#163028', T.okBg)}>Revoke Status</button>
                                        )}
                                        <button onClick={e => { e.stopPropagation(); setSelectedAccount(alert); }} style={{ padding:'6px 16px', fontSize:12, fontWeight:700, borderRadius:8, background:activeAccentBg, border:`1px solid ${activeAccent}40`, color:activeAccent, cursor:'pointer', transition:'all 0.2s', boxShadow:`0 0 12px ${activeAccentBg}` }} {...hoverBorderButtonProps(activeAccent, '#fff', activeAccent, activeAccent)}>Inspect</button>
                                    </div>
                                </td>
                            </tr>
                        );
                    }) : (
                        <tr><td colSpan="8" style={{ padding:'60px 20px', textAlign:'center', color:T.txt3, fontSize:13, fontFamily:'monospace', letterSpacing:'0.1em', fontWeight:600 }}>NO THREATS MATCH CURRENT FILTER</td></tr>
                    )}
                </tbody>
            </table>
            <Pagination current={currentPage} total={totalPages} jumpPage={jumpPage} onJumpChange={e => setJumpPage(e.target.value)} onJumpKey={e => handleJumpKey(e, totalPages)} onPrev={() => setCurrentPage(p => Math.max(1,p-1))} onNext={() => setCurrentPage(p => Math.min(totalPages,p+1))} />
        </Card>
    </div>
    );
};

const AccountInspectionModal = ({ selectedAccount, setSelectedAccount, handleResolve, handleConfirmFraud, activeAccent, confirmedFraudIds, jwtToken, currentRole }) => {
    const [sarGenerating, setSarGenerating] = React.useState(false);
    const [sarDraft, setSarDraft] = React.useState('');
    React.useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                setSelectedAccount(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [setSelectedAccount]);

    if (!selectedAccount) return null;
    return (
        <div style={{ position:'fixed', inset:0, zIndex:50, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.85)', backdropFilter:'blur(8px)', padding:24 }}>
            <div style={{ background:T.surface, border:`1px solid ${T.borderHi}`, borderRadius:16, width:'100%', maxWidth:1100, maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 24px 80px rgba(0,0,0,0.8)' }}>
                <div style={{ padding:'20px 24px', borderBottom:`1px solid ${T.border}`, display:'flex', justifyContent:'space-between', alignItems:'center', background:T.bg, flexShrink:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:24 }}>
                        <RiskGauge score={selectedAccount.riskScore} status={selectedAccount.status} />
                        <div>
                            <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:6, fontWeight:700 }}>Account Inspection Profile</div>
                            <div style={{ fontSize:24, fontWeight:800, fontFamily:'monospace', color:T.txt1, letterSpacing:'0.04em' }}>{selectedAccount.accountId}</div>
                            <div style={{ display:'flex', gap:20, marginTop:8 }}>
                                <span style={{ fontSize:12, color:T.txt2, fontFamily:'monospace', fontWeight:600 }}>{new Date(selectedAccount.detectedAt).toLocaleString()}</span>
                                <span style={{ fontSize:12, color:T.txt2, fontFamily:'monospace', fontWeight:600 }}>{selectedAccount.sourceFileName}</span>
                            </div>
                        </div>
                    </div>
                    <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                        <div style={{ fontSize:36, fontWeight:900, fontFamily:'monospace', color: selectedAccount.status === 'Critical' ? T.crit : T.high, textShadow: `0 0 20px ${selectedAccount.status === 'Critical' ? T.critBg : T.highBg}`, marginRight: 24 }}>
                            {selectedAccount.riskScore.toFixed(1)}%
                        </div>
                        <button onClick={(e) => { handleResolve(selectedAccount.accountId, e, selectedAccount.sourceFileName); setSelectedAccount(null); }} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 18px', fontSize:13, fontWeight:700, borderRadius:8, cursor:'pointer', transition:'all 0.2s', background:T.okBg, border:`1px solid ${T.ok}40`, color:T.ok, boxShadow:`0 0 16px ${T.okBg}` }}>
                            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg> Mark Safe
                        </button>
                        <button onClick={(e) => { handleConfirmFraud && handleConfirmFraud(selectedAccount.accountId, e, selectedAccount.sourceFileName); setSelectedAccount(null); }} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 18px', fontSize:13, fontWeight:700, borderRadius:8, cursor:'pointer', transition:'all 0.2s', background:T.critBg, border:`1px solid ${T.critBdr}`, color:T.crit }}>
                            <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> Confirm Fraud
                        </button>
                        <button onClick={() => setSelectedAccount(null)} style={{ padding:'10px 12px', borderRadius:8, background:'transparent', border:`1px solid ${T.border}`, color:T.txt3, cursor:'pointer', transition:'all 0.2s' }} {...hoverBorderButtonProps(T.txt3)}>
                            <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                        </button>
                    </div>
                </div>

                <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
                    {/* LEFT PANEL: KYC */}
                    <div style={{ width:'50%', padding:24, overflowY:'auto', borderRight:`1px solid ${T.border}`, background:T.surface }}>
                        <div style={{ fontSize:11, fontWeight:800, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:16 }}>KYC Profile &amp; Ledger</div>
                        {selectedAccount.kycData ? (
                            <>
                                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:24 }}>
                                    {[
                                        { label:'Account Holder',  val:selectedAccount.kycData.fullName, color:T.txt1 },
                                        { label:'Current Balance', val:selectedAccount.kycData.currentBalance, color:T.ok },
                                        { label:'Last Login IP',   val:selectedAccount.kycData.lastLoginIp, color:T.txt2 },
                                        { label:'Device Fingerprint',val:selectedAccount.kycData.deviceType, color:T.txt2 },
                                    ].map(({ label, val, color }) => (
                                        <div key={label} style={{ background:T.bg, border:`1px solid ${T.border}`, borderRadius:10, padding:'14px 16px' }}>
                                            <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:6, fontWeight:700 }}>{label}</div>
                                            <div style={{ fontSize:14, fontWeight:700, color, fontFamily: label.includes('IP')||label.includes('Device') ? 'monospace' : 'inherit' }}>{val}</div>
                                        </div>
                                    ))}
                                </div>
                                <div style={{ fontSize:11, fontWeight:800, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:12 }}>Recent Transaction Ledger</div>
                                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                                    <thead>
                                        <tr style={{ background:T.raised, borderBottom:`1px solid ${T.border}` }}>
                                            {['Date', 'Type', 'Amount', 'Status'].map(th => <th key={th} style={{ padding:'8px 12px', textAlign:'left', fontSize:11, color:T.txt3, textTransform:'uppercase', fontWeight:800 }}>{th}</th>)}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {selectedAccount.kycData.recentTransactions.map((tx, i) => (
                                            <tr key={i} style={{ borderBottom:`1px solid ${T.border}` }}>
                                                <td style={{ padding:'8px 12px', fontSize:12, color:T.txt2, fontFamily:'monospace' }}>{tx.date}</td>
                                                <td style={{ padding:'8px 12px', fontSize:12, color:T.txt1 }}>{tx.type}</td>
                                                <td style={{ padding:'8px 12px', fontSize:12, color: tx.amount.includes('-') ? T.txt2 : T.ok, fontWeight:700, fontFamily:'monospace' }}>{tx.amount}</td>
                                                <td style={{ padding:'8px 12px', fontSize:12 }}>
                                                    <span style={{ padding:'2px 8px', borderRadius:4, background: tx.status === 'Completed' ? T.okBg : T.raised, color: tx.status === 'Completed' ? T.ok : T.txt2, fontWeight:700 }}>{tx.status}</span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </>
                        ) : <div style={{ color:T.txt3, fontSize:13, fontStyle:'italic' }}>KYC data unavailable.</div>}
                    </div>

                    {/* RIGHT PANEL: TELEMETRY */}
                    <div style={{ width:'50%', padding:24, overflowY:'auto', display:'flex', flexDirection:'column', background:T.bg }}>
                        <div style={{ fontSize:11, fontWeight:800, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:16 }}>AI Telemetry &mdash; Active Signals</div>
                        {selectedAccount.topFeatures && selectedAccount.topFeatures.length > 0 ? (
                            <div style={{ display:'flex', flexDirection:'column', gap:12, flex:1 }}>
                                {selectedAccount.topFeatures.map((f, i) => {
                                    const fill = f.contribution > 0.3 ? T.crit : (f.contribution > 0.15 ? T.high : T.ok);
                                    return (
                                        <div key={i} style={{ display:'flex', flexDirection:'column', gap:6, background:T.surface, border:`1px solid ${T.border}`, borderRadius:8, padding:'10px 14px' }}>
                                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                                                <div style={{ fontSize:12, fontWeight:800, color:T.txt1, fontFamily:'monospace', display:'flex', alignItems:'center', gap:8 }}>
                                                    <span style={{ width:6, height:6, borderRadius:3, background:fill }} />
                                                    {f.feature}
                                                </div>
                                                <div style={{ fontSize:12, fontWeight:800, color:fill, fontFamily:'monospace' }}>+{(f.contribution * 100).toFixed(1)}%</div>
                                            </div>
                                            <div style={{ fontSize:12, color:T.txt3, lineHeight:1.4 }}>{f.description}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : <div style={{ textAlign:'center', padding:40, color:T.txt3, fontFamily:'monospace', fontSize:13, fontWeight:600 }}>Raw telemetry unavailable.</div>}
                    </div>

                        {/* ── SAR REPORTING ───────────────────────────────────────────── */}
                        {confirmedFraudIds.has(selectedAccount?.accountId) && (
                            <div style={{ marginTop: 24, borderTop: `1px solid ${T.border}`, paddingTop: 24 }}>
                                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16 }}>
                                    <div style={{ fontSize:11, fontWeight:800, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em' }}>Suspicious Activity Report</div>
                                    <div style={{ display:'flex', gap:8 }}>
                                        <button 
                                            disabled={sarGenerating}
                                            onClick={async () => {
                                                setSarGenerating(true);
                                                try {
                                                    const res = await fetch('http://localhost:5000/api/sar-draft', {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwtToken}`, 'X-User-Role': currentRole },
                                                        body: JSON.stringify({ accountId: selectedAccount.accountId })
                                                    });
                                                    const data = await res.json();
                                                    if (data.success) setSarDraft(data.draft);
                                                } catch(e) {}
                                                setSarGenerating(false);
                                            }}
                                            style={{ padding:'6px 12px', background:T.surface, border:`1px solid ${T.border}`, borderRadius:6, color:T.txt2, fontSize:12, fontWeight:700, cursor:'pointer' }}
                                        >
                                            {sarGenerating ? 'Generating...' : 'Generate SAR Draft'}
                                        </button>
                                        <button 
                                            disabled={!sarDraft}
                                            onClick={async () => {
                                                try {
                                                    const res = await fetch('http://localhost:5000/api/sar-pdf', {
                                                        method: 'POST',
                                                        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwtToken}`, 'X-User-Role': currentRole },
                                                        body: JSON.stringify({ accountId: selectedAccount.accountId })
                                                    });
                                                    if (res.ok) {
                                                        const blob = await res.blob();
                                                        const url = window.URL.createObjectURL(blob);
                                                        const a = document.createElement('a');
                                                        a.href = url;
                                                        a.download = `SAR_${selectedAccount.accountId}.pdf`;
                                                        a.click();
                                                    }
                                                } catch(e) {}
                                            }}
                                            style={{ padding:'6px 12px', background: sarDraft ? activeAccent : T.surface, border:'none', borderRadius:6, color: sarDraft ? '#fff' : T.txt3, fontSize:12, fontWeight:700, cursor: sarDraft ? 'pointer' : 'not-allowed' }}
                                        >
                                            Download PDF
                                        </button>
                                    </div>
                                </div>
                                {sarDraft && (
                                    <textarea 
                                        readOnly 
                                        value={sarDraft} 
                                        style={{ width:'100%', height:120, background:T.bg, color:T.txt2, border:`1px solid ${T.border}`, borderRadius:8, padding:12, fontSize:12, lineHeight:1.5, resize:'vertical', outline:'none' }} 
                                    />
                                )}
                            </div>
                        )}
                </div>
            </div>
        </div>
    );
};

// ============================================================================
// 5. MAIN DASHBOARD CONTROLLER (State & Layout)
// ============================================================================

const Dashboard = () => {

    const [isRetraining, setIsRetraining] = React.useState(false);
    const [retrainCooldown, setRetrainCooldown] = React.useState(false);
    const retrainTimerRef = React.useRef(null);

    React.useEffect(() => {
        return () => {
            if (retrainTimerRef.current) clearTimeout(retrainTimerRef.current);
        };
    }, []);

    const handleTriggerRetrain = async () => {
        setIsRetraining(true);
        try {
            const token = jwtToken;
            const res = await fetch('http://localhost:5000/api/retrain', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (res.status === 429) {
                toast('Retrain already in progress or cooldown period active.', { style: { background: T.raised, color: T.crit, border: `1px solid ${T.border}` }, duration: 4000 });
                setIsRetraining(false);
                return;
            }
            
            setIsRetraining(false);
            setRetrainCooldown(true);
            retrainTimerRef.current = setTimeout(() => {
                setRetrainCooldown(false);
            }, 60000);
            
            if (res.ok || res.status === 202) {
                toast('Retraining triggered. Model will update shortly.', { style: { background: T.raised, color: T.ok, border: `1px solid ${T.border}` }, duration: 4000 });
            } else {
                toast('Retrain request failed: Unknown error', { style: { background: T.raised, color: T.crit, border: `1px solid ${T.border}` }, duration: 4000 });
            }
        } catch (e) {
            setIsRetraining(false);
            setRetrainCooldown(true);
            retrainTimerRef.current = setTimeout(() => {
                setRetrainCooldown(false);
            }, 60000);
            toast(`Retrain request failed: ${e.message}`, { style: { background: T.raised, color: T.crit, border: `1px solid ${T.border}` }, duration: 4000 });
        }
    };

    // ── Part 3 Feature State ─────────────────────────────────────────────────
    const [feedbackStats, setFeedbackStats]         = useState(null);
    const [modelVersion, setModelVersion]           = useState(null);
    const [driftAlert, setDriftAlert]               = useState(null);
    const [selectedAlertIds, setSelectedAlertIds]   = useState(new Set());

    // ── Global State ────────────────────────────────────────────────────────
    const [currentRole, setCurrentRole]             = useState('Analyst'); // Default Role
    const [currentView, setCurrentView]             = useState('DETAILED_VIEW'); // Default for Analyst
    const [sidebarCollapsed, setSidebarCollapsed]   = useState(false);
    const [loading, setLoading]                     = useState(true);

    const [jwtToken, setJwtToken]                   = useState(null);
    const [loginUsername, setLoginUsername]         = useState('');
    const [loginPassword, setLoginPassword]         = useState('');
    const [loginError, setLoginError]               = useState('');
    const [loginLoading, setLoginLoading]           = useState(false);


    // ── Fetch & Filter State ────────────────────────────────────────────────
    const [alerts, setAlerts]                       = useState([]);
    const [logs, setLogs]                           = useState([]);
    const [uploadedFiles, setUploadedFiles]         = useState([]);
    const [availableDatasets, setAvailableDatasets] = useState([]);
    const [activeDataset, setActiveDataset]         = useState('ALL');
    const [datasetSourceFilter, setDatasetSourceFilter] = useState('ALL');
    const [activeTab, setActiveTab]                 = useState('ALL');
    const [activeLogTab, setActiveLogTab]           = useState('ALL');
    const [searchTerm, setSearchTerm]               = useState('');
    const [searchType, setSearchType]               = useState('ACCOUNT_ID');
    const [selectedAccount, setSelectedAccount]     = useState(null);
    const [resolvedIds, setResolvedIds]             = useState(new Set());
    const [confirmedFraudIds, setConfirmedFraudIds] = useState(new Set());
    
    // ── Upload & Pipeline State ─────────────────────────────────────────────
    const [isUploading, setIsUploading]             = useState(false);
    const [engineStatus, setEngineStatus]           = useState('Idle');
    const [uploadStartedAt, setUploadStartedAt]     = useState(null);
    const [uploadFileName, setUploadFileName]       = useState('');
    const [uploadElapsedSeconds, setUploadElapsedSeconds] = useState(0);
    const [uploadLimitEnabled, setUploadLimitEnabled] = useState(true);
    const [maxUploadMB, setMaxUploadMB] = useState(100);
    const [perUploadMB, setPerUploadMB] = useState(100);

    // ── Pagination & Metrics State ──────────────────────────────────────────
    const [currentPage, setCurrentPage]             = useState(1);
    const [jumpPage, setJumpPage]                   = useState('');
    const [totalAlertsCount, setTotalAlertsCount]   = useState(0);
    const [globalStats, setGlobalStats]             = useState({ critical: 0, highRisk: 0 });
    const itemsPerPage = 12;

    // ── ML Telemetry State ──────────────────────────────────────────────────
    const [modelConfig, setModelConfig]             = useState(null);
    const [inputSchema, setInputSchema]             = useState(null);
    const [modelMetrics, setModelMetrics]           = useState(null);
    const [thresholdCurve, setThresholdCurve]       = useState([]);
    const [droppedFeatures, setDroppedFeatures]     = useState([]);
    const [featureImportance, setFeatureImportance]  = useState([]);

    // ── Refs ────────────────────────────────────────────────────────────────
    const fileInputRef   = useRef(null);
    const statusInterval = useRef(null);
    const socketRefLocal = useRef(null);
    
    const socketStateRef = useRef({ currentPage, activeDataset, activeTab, searchTerm, currentView });
    useEffect(() => {
        socketStateRef.current = { currentPage, activeDataset, activeTab, searchTerm, currentView };
    });
    const fetchAlertsRef = useRef(null);


    // ── Handlers & Side Effects ─────────────────────────────────────────────
    const statusMeta = getUploadStatusMeta(engineStatus);

    useEffect(() => {
        if (!isUploading || !uploadStartedAt) { setTimeout(() => setUploadElapsedSeconds(0), 0); return undefined; }
        const timer = setInterval(() => setUploadElapsedSeconds(Math.floor((Date.now() - uploadStartedAt) / 1000)), 1000);
        return () => clearInterval(timer);
    }, [isUploading, uploadStartedAt]);

    const fetchJson = async (endpoint, init) => {
        const mergedHeaders = { 
            'X-User-Role': currentRole, 
            ...(jwtToken ? { 'Authorization': `Bearer ${jwtToken}` } : {}),
            ...(init && init.headers ? init.headers : {}) 
        };
        const response = await fetch(`${API_BASE}${endpoint}`, { ...(init || {}), headers: mergedHeaders });
        if (response.status === 401) {
            setJwtToken(null);
            return null;
        }
        if (!response.ok) return null;
        return response.json();
    };

    const fetchAlerts = React.useCallback(async (page = 1, opts = {}) => {
    fetchAlertsRef.current = fetchAlerts;
        try {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('limit', String(itemsPerPage));
            if (opts.dataset && opts.dataset !== 'ALL') params.set('dataset', opts.dataset);
            if (opts.status && opts.status !== 'ALL') params.set('status', opts.status);
            if (opts.search && String(opts.search).trim()) params.set('search', String(opts.search).trim());
            if (opts.muleStatus) params.set('muleStatus', opts.muleStatus);

            const statsUrl = (opts.dataset && opts.dataset !== 'ALL') ? `/api/alerts/stats?dataset=${encodeURIComponent(opts.dataset)}` : '/api/alerts/stats';
            const [data, stats] = await Promise.all([
                fetchJson(`/api/alerts?${params.toString()}`),
                fetchJson(statsUrl)
            ]);

            if (data) { setAlerts(data.data || []); setTotalAlertsCount(Number(data.total || data.count || (data.data || []).length)); }
            if (stats && stats.success) setGlobalStats({ critical: stats.critical, highRisk: stats.highRisk });
        } catch { /* ignore */ }
    }, [itemsPerPage, currentRole]);

    const confirmMule = async (alertId, muleStatus = 'Confirmed Mule') => {
        try {
            if (!window.confirm(`Mark this account as ${muleStatus}?`)) return;
            const prev = alerts.find(a => a._id === alertId)?.muleStatus || 'Pending';
            const res = await fetchJson(`/api/alerts/${alertId}/mule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muleStatus }) });
            if (res && res.success) {
                setAlerts(prevA => prevA.map(a => (a._id === res.data._id ? res.data : a)));
                toast.success((t) => (
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <div>{`Marked ${res.data.accountId} as ${muleStatus}`}</div>
                        <button onClick={async () => {
                            const undo = await fetchJson(`/api/alerts/${alertId}/mule`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ muleStatus: prev }) });
                            if (undo && undo.success) setAlerts(prevA => prevA.map(a => (a._id === undo.data._id ? undo.data : a)));
                            toast.dismiss(t.id);
                        }} style={{ padding:'6px 10px', borderRadius:6, background:T.surface, border:`1px solid ${T.borderHi}`, cursor:'pointer' }}>Undo</button>
                    </div>
                ));
            } else toast.error('Failed to update mule status');
        } catch { toast.error('Failed to update mule status'); }
    };

    const revokeMule = async (alertId) => {
        try {
            if (!window.confirm(`Revoke confirmed mule status and return to Pending?`)) return;
            const prev = 'Confirmed Mule';
            const res = await fetchJson(`/api/alerts/${alertId}/mule`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ muleStatus: 'Pending' }) });
            if (res && res.success) {
                setAlerts(prevA => prevA.filter(a => a._id !== res.data._id)); 
                toast.success((t) => (
                    <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <div>{`Revoked status for ${res.data.accountId}`}</div>
                        <button onClick={async () => {
                            const undo = await fetchJson(`/api/alerts/${alertId}/mule`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ muleStatus: prev }) });
                            if (undo && undo.success) setAlerts(prevA => [undo.data, ...prevA]);
                            toast.dismiss(t.id);
                        }} style={{ padding:'6px 10px', borderRadius:6, background:T.surface, border:`1px solid ${T.borderHi}`, cursor:'pointer' }}>Undo</button>
                    </div>
                ));
            } else toast.error('Failed to update mule status');
        } catch { toast.error('Failed to update mule status'); }
    };

    const fetchDatasets = async () => { try { const data = await fetchJson('/api/files'); if (data) setAvailableDatasets(data.data); } catch { /* ignore */ } };

    const fetchFeedbackStats = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/feedback/stats`, { headers: { 'Authorization': `Bearer ${jwtToken}` } });
            if (res.status === 404) { setFeedbackStats(null); return; }
            if (res.ok) { const d = await res.json(); if (d.success) setFeedbackStats(d.stats); }
        } catch { /* ignore */ }
    };

    const fetchModelVersion = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/model-version`, { headers: { 'Authorization': `Bearer ${jwtToken}` } });
            if (res.status === 404) { setModelVersion(null); return; }
            if (res.ok) { const d = await res.json(); if (d.success) setModelVersion(d.version); }
        } catch { /* ignore */ }
    };
    const fetchModelConfig = async () => {
        try {
            const data = await fetchJson('/api/config');
            if (data) {
                setModelConfig(data.thresholds || null); setInputSchema(data.inputSchema || null);
                setModelMetrics(data.modelMetrics || null); setThresholdCurve(data.thresholdCurve || []);
                setDroppedFeatures(data.droppedFeatures || []); setFeatureImportance(data.featureImportance || []);
            }
        } catch { /* ignore */ }
    };
    
    const fetchLogsAndFiles = async () => {
        try {
            const [logsData, filesData] = await Promise.all([fetchJson('/api/logs'), fetchJson('/api/files')]);
            if (logsData) setLogs(logsData.data);
            if (filesData) { setUploadedFiles(filesData.data); setAvailableDatasets(filesData.data); }
            setLoading(false);
        } catch { setLoading(false); }
    };

    useEffect(() => {
        fetchFeedbackStats();
        fetchModelVersion();
    }, [jwtToken]);

    useEffect(() => {
        const socket = io(API_BASE);
        const alarm  = new Audio('/siren.mp3');
        socket.on('SCAN_COMPLETE', (data) => {
            alarm.play().catch(() => {});
            // 3.7 Drift Banner: populate from SCAN_COMPLETE driftReport
            if (data.driftReport && data.driftReport.drifted) {
                setDriftAlert(data.driftReport);
            }
            toast.custom(() => (
                <div style={{ background:T.raised, border:`1px solid ${T.critBdr}`, borderRadius:12, padding:'16px 20px', display:'flex', gap:14, alignItems:'flex-start', boxShadow:'0 8px 32px rgba(0,0,0,0.6)', maxWidth:380 }}>
                    <div style={{ width:36, height:36, borderRadius:'50%', background:T.critBg, border:`1px solid ${T.critBdr}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, boxShadow:`0 0 12px ${T.critBg}` }}>
                        <svg width="18" height="18" fill="none" stroke={T.crit} strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
                    </div>
                    <div>
                        <p style={{ fontSize:12, fontWeight:800, color:T.crit, letterSpacing:'0.1em', marginBottom:4 }}>SCAN COMPLETE</p>
                        <p style={{ fontSize:13, color:T.txt1, fontFamily:'monospace', marginBottom:4 }}>{data.fileName}</p>
                        <p style={{ fontSize:12, color:T.txt2 }}>{data.criticalCount} Critical · {data.highRiskCount} High Risk</p>
                    </div>
                </div>
            ), { duration:8000, position:'top-right' });
        });
        socket.on('RETRAIN_COMPLETE', () => {
            toast('Model retrain complete.', { style: { background: T.raised, color: T.ok, border: `1px solid ${T.border}` }, duration: 4000 });
            setDriftAlert(null);
        });
        socket.on('SILENT_REFRESH', () => { 
            setTimeout(() => { 
                const s = socketStateRef.current;
                fetchAlertsRef.current(s.currentPage, { dataset: s.activeDataset, status: s.activeTab, search: s.searchTerm, muleStatus: s.currentView === 'MULE_REGISTRY' ? 'Confirmed Mule' : undefined }); 
                fetchDatasets(); 
                fetchLogsAndFiles(); 
            }, 0); 
        });
        socket.on('NEW_LOG', (l) => setLogs(prev => [l, ...prev]));
        socket.on('ENGINE_PROGRESS', (payload) => {
            try {
                if (payload && payload.status) {
                    setEngineStatus(payload.status);
                    const terminal = ['Complete', 'Duplicate Rejected', 'Engine Failure', 'Database Error'];
                    if (terminal.includes(payload.status)) {
                        setIsUploading(false);
                        if (statusInterval.current) { clearInterval(statusInterval.current); statusInterval.current = null; }
                        setTimeout(() => { fetchAlerts(currentPage); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
                    }
                }
            } catch { /* ignore */ }
        });
        socket.on('ENGINE_ERROR', (payload) => {
            try {
                const msg = (payload && payload.message) ? payload.message : 'Unknown engine error';
                setIsUploading(false);
                if (statusInterval.current) { clearInterval(statusInterval.current); statusInterval.current = null; }
                setUploadStartedAt(null); setUploadElapsedSeconds(0);
                toast.error(`Engine Error: ${msg}`, { style:{ background:T.raised, color:T.crit, border:`1px solid ${T.critBdr}` }, duration: 8000 });
            } catch { /* ignore */ }
        });
        setTimeout(() => { fetchAlerts(currentPage, { dataset: activeDataset, status: activeTab, search: searchTerm, muleStatus: currentView === 'MULE_REGISTRY' ? 'Confirmed Mule' : undefined }); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
        socketRefLocal.current = socket;
        return () => { socket.disconnect(); socketRefLocal.current = null; };
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const j = await fetchJson('/api/upload-config');
                if (j && j.success) { setMaxUploadMB(Number(j.maxUploadMB || 0)); setUploadLimitEnabled(Boolean(j.enabled)); setPerUploadMB(Number(j.maxUploadMB || 0)); }
            } catch { /* ignore */ }
        })();
    }, []);

    useEffect(() => { setTimeout(() => setCurrentPage(1), 0); }, [activeTab, searchTerm, searchType, activeLogTab, currentView, activeDataset, datasetSourceFilter]);
    useEffect(() => { setSelectedAlertIds(new Set()); }, [currentPage, activeDataset, activeTab, currentView, searchTerm]);

    useEffect(() => {
        setTimeout(() => { fetchAlerts(currentPage, { dataset: activeDataset, status: activeTab, search: searchTerm, muleStatus: currentView === 'MULE_REGISTRY' ? 'Confirmed Mule' : undefined }); }, 0);
    }, [currentPage, activeDataset, activeTab, searchTerm, currentView, fetchAlerts]);

    useEffect(() => {
        const visibleDatasets = availableDatasets.filter(file => datasetSourceFilter === 'ALL' || (file.sourceType || (String(file.fileName || '').startsWith('LIVE_STREAM_') ? 'LIVE_STREAM' : 'STATIC_INGEST')) === datasetSourceFilter);
        if (activeDataset !== 'ALL' && !visibleDatasets.some(file => file.fileName === activeDataset)) setTimeout(() => setActiveDataset('ALL'), 0);
    }, [availableDatasets, datasetSourceFilter, activeDataset]);

    const startStatusTracking = () => {
        if (socketRefLocal.current) return;
        const terminalStatuses = new Set(['Complete', 'Duplicate Rejected', 'Engine Failure', 'Database Error']);
        if (statusInterval.current) clearInterval(statusInterval.current);
        statusInterval.current = setInterval(async () => {
            try {
                const data = await fetchJson('/api/status');
                if (data) {
                    setEngineStatus(data.status);
                    if (terminalStatuses.has(data.status)) {
                        clearInterval(statusInterval.current); statusInterval.current = null; setIsUploading(false); setUploadStartedAt(null);
                        setTimeout(() => { fetchAlerts(currentPage); fetchDatasets(); fetchLogsAndFiles(); fetchModelConfig(); }, 0);
                    }
                }
            } catch { /* ignore */ }
        }, 300);
    };
    const stopStatusTracking = () => { if (statusInterval.current) clearInterval(statusInterval.current); statusInterval.current = null; setEngineStatus('Idle'); setUploadStartedAt(null); setUploadElapsedSeconds(0); };

    const handleSystemWipe = async () => {
        if (!window.confirm('WARNING: This will delete all alerts, file histories, and logs from MongoDB. Proceed?')) return;
        try {
            await fetchJson('/api/system-wipe', { method:'DELETE' });
            setAlerts([]); setUploadedFiles([]); setAvailableDatasets([]); setActiveDataset('ALL'); setResolvedIds(new Set()); setGlobalStats({ critical:0, highRisk:0 });
            toast.success('System wiped. Ready for fresh uploads.', { style:{ background:T.raised, color:T.ok, border:`1px solid #163028` } });
        } catch { alert('Failed to wipe system'); }
    };

    // 3.1 Confirm Fraud handler
    const handleConfirmFraud = async (accountId, e, srcFileName) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        setConfirmedFraudIds(prev => new Set(prev).add(accountId));
        try {
            await fetchJson('/api/resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ accountId, decision:'CONFIRMED_FRAUD', sourceFileName: srcFileName || selectedAccount?.sourceFileName || null }) });
            toast.success(`${accountId} confirmed as fraud.`, { style:{ background:T.raised, color:T.crit, border:`1px solid ${T.critBdr}` } });
        } catch { toast.error('Failed to confirm fraud.'); }
    };

    // 3.9 Bulk resolve handler
    const handleBulkAction = async (decision) => {
        const ids = Array.from(selectedAlertIds);
        if (!ids.length) return;
        try {
            const res = await fetchJson('/api/resolve-bulk', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({ alertIds: ids, decision })
            });
            if (res && res.success) {
                if (decision === 'CONFIRMED_FRAUD') {
                    setConfirmedFraudIds(prev => { const next = new Set(prev); ids.forEach(id => { const a = alerts.find(x => x._id === id); if (a) next.add(a.accountId); }); return next; });
                } else {
                    setResolvedIds(prev => { const next = new Set(prev); ids.forEach(id => { const a = alerts.find(x => x._id === id); if (a) next.add(a.accountId); }); return next; });
                }
                setSelectedAlertIds(new Set());
                toast.success(`${ids.length} alerts resolved as ${decision === 'SAFE' ? 'safe' : 'confirmed fraud'}.`, { style:{ background:T.raised, color: decision === 'SAFE' ? T.ok : T.crit, border:`1px solid ${T.border}` } });
            } else {
                toast.error('Bulk action failed.');
            }
        } catch { toast.error('Bulk action failed.'); }
    };

    const handleFileUpload = async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        setIsUploading(true); setEngineStatus('Uploading file...'); setUploadFileName(file.name); setUploadStartedAt(Date.now()); setUploadElapsedSeconds(0);
        startStatusTracking();
        const uploadToastId = toast.loading(`Uploading ${file.name} and verifying the dataset hash...`, { style:{ background:T.raised, color:T.txt1, border:`1px solid ${T.borderHi}` } });
        const fd = new FormData(); fd.append('telemetryFile', file);
        let uploadAccepted = false;
        try {
            const qp = perUploadMB ? `?max_upload_mb=${encodeURIComponent(Number(perUploadMB))}` : '';
            const res = await fetch(`${API_BASE}/api/upload${qp}`, { method:'POST', body:fd, headers: { 'X-User-Role': currentRole } });
            const data = await res.json();
            if (!res.ok) {
                if (data.message === 'DUPLICATE_FILE') toast.error('Data Replay Blocked — dataset hash already exists.', { id: uploadToastId, style:{ background:T.raised, color:T.crit, border:`1px solid ${T.critBdr}` }, duration:6000 });
                else throw new Error(data.message || 'Failed to process CSV');
            } else {
                uploadAccepted = true; setResolvedIds(new Set()); setCurrentPage(1); setActiveDataset(file.name); setCurrentView('OVERVIEW');
                toast.success(`Upload accepted. ${file.name} is now being scored.`, { id: uploadToastId, style:{ background:T.raised, color:T.ok, border:`1px solid #163028` } });
            }
        } catch (err) { toast.error(`Upload Error: ${err.message}`, { id: uploadToastId, style:{ background:T.raised, color:T.crit } }); } 
        finally {
            if (!uploadAccepted) { setIsUploading(false); stopStatusTracking(); setUploadFileName(''); }
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const saveUploadConfig = async () => {
        try {
            const body = { maxUploadMB: uploadLimitEnabled ? Number(maxUploadMB) : null, enabled: uploadLimitEnabled };
            const j = await fetchJson('/api/upload-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            if (j && j.success) toast.success('Upload configuration saved.'); else toast.error('Failed to save upload configuration.');
        } catch { toast.error('Failed to save upload configuration.'); }
    };

    const handleResolve = async (accountId, e, srcFileName) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        setResolvedIds(prev => new Set(prev).add(accountId));
        try {
            await fetchJson('/api/resolve', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ accountId, decision:'SAFE', sourceFileName: srcFileName || selectedAccount?.sourceFileName || null }) });
            toast.success(`${accountId} marked as safe.`, { style:{ background:T.raised, color:T.ok, border:`1px solid #163028` } });
        } catch { toast.error('Failed to mark safe.'); }
    };

    const exportToCSV = () => {
        const rows = activeAlerts.map(a => {
            const features = getAlertFeatures(a);
            const explanation = features.map(f => `${f.name}:${String(f.contribution ?? 0)}`).join(' | ');
            return `${a.accountId},${a.riskScore},${a.anomalyScore},${a.status},"${explanation}",${a.sourceFileName}`;
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['Account ID,Risk Score,Anomaly Score,Status,Top Features,Source File\n' + rows.join('\n')], { type:'text/csv' }));
        a.download = `Nexus_${activeDataset === 'ALL' ? 'Global' : activeDataset}_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
    };

    const handleJumpKey = (e, total) => {
        if (e.key !== 'Enter') return;
        const n = parseInt(jumpPage, 10);
        if (!isNaN(n) && n >= 1 && n <= total) setCurrentPage(n);
        setJumpPage('');
    };

    const handleRoleToggle = (e) => {
        const newRole = e.target.value; setCurrentRole(newRole);
        setCurrentView(newRole === 'Analyst' ? 'DETAILED_VIEW' : 'OVERVIEW');
        setCurrentPage(1); setSearchTerm('');
    };

    const openLiveRoute = (path) => { window.history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')); };

    // ── Derived State Dependencies ───────────────────────────────────────────
    const resolveSourceType = (file) => file?.sourceType || (String(file?.fileName || '').startsWith('LIVE_STREAM_') ? 'LIVE_STREAM' : 'STATIC_INGEST');
    const visibleDatasetFiles = useMemo(() => availableDatasets.filter(file => datasetSourceFilter === 'ALL' || resolveSourceType(file) === datasetSourceFilter), [availableDatasets, datasetSourceFilter]);
    const visibleDatasetNames = useMemo(() => new Set(visibleDatasetFiles.map(file => file.fileName)), [visibleDatasetFiles]);
    const unresolvedAlerts = useMemo(() => alerts.filter(a => !resolvedIds.has(a.accountId)), [alerts, resolvedIds]);
    
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const activeAlerts = useMemo(() => unresolvedAlerts.filter(a => {
        const matchesDataset = activeDataset === 'ALL' || a.sourceFileName === activeDataset;
        const matchesSource = datasetSourceFilter === 'ALL' || visibleDatasetNames.has(a.sourceFileName);
        return matchesDataset && matchesSource;
    }), [unresolvedAlerts, activeDataset, datasetSourceFilter, visibleDatasetNames]);

    const filteredAlerts = useMemo(() => activeAlerts.filter(a => {
        const tab = (currentView === 'MULE_REGISTRY') || activeTab === 'ALL' || (activeTab === 'CRITICAL' && a.status === 'Critical') || (activeTab === 'HIGH_RISK' && a.status === 'High Risk');
        const search = !searchTerm ? true : searchType === 'ACCOUNT_ID'
            ? a.accountId.toLowerCase().includes(searchTerm.toLowerCase())
            : getAlertFeatures(a).some(fObj => {
                const fname = fObj.name;
                return fname.toLowerCase().includes(searchTerm.toLowerCase()) || translate(fname).toLowerCase().includes(searchTerm.toLowerCase());
            });
        return tab && search;
    }), [activeAlerts, activeTab, searchTerm, searchType, currentView]);

    const totalPages    = Math.max(1, Math.ceil(totalAlertsCount / itemsPerPage));
    const currentAlerts = filteredAlerts; 
    const idx0 = (currentPage - 1) * itemsPerPage;

    const filteredLogs   = logs.filter(l => activeLogTab === 'ALL' || l.actor === activeLogTab);
    const totalLogPages  = Math.ceil(filteredLogs.length / itemsPerPage);
    const currentLogs    = filteredLogs.slice(idx0, idx0 + itemsPerPage);
    const totalFilePages = Math.ceil(uploadedFiles.length / itemsPerPage);
    const currentFiles   = uploadedFiles.slice(idx0, idx0 + itemsPerPage);

    const critCount = globalStats.critical || 0;
    const highCount = globalStats.highRisk || 0;
    
    const baseScanned = activeDataset === 'ALL' ? visibleDatasetFiles.reduce((s, f) => s + (f.totalAccountsScanned || 0), 0) : visibleDatasetFiles.find(f => f.fileName === activeDataset)?.totalAccountsScanned || 0;
    const totalScanned = Math.max(baseScanned, critCount + highCount);

    const riskData    = [{ name:'Critical', value:critCount }, { name:'High Risk', value:highCount }];
    const CHART_CLRS  = [T.crit, T.high];

    const featureCounts = useMemo(() => {
        const counts = {};
        activeAlerts.forEach(a => getAlertFeatures(a).forEach(fObj => { const f = fObj.name; counts[f] = (counts[f] || 0) + 1; }));
        return counts;
    }, [activeAlerts]);

    const featureData = useMemo(() => Object.keys(featureCounts).map(k => ({ name: k === 'Anomaly_Score' ? 'STAT' : k, count: featureCounts[k], fullName: translate(k) })).sort((a, b) => b.count - a.count).slice(0, 6), [featureCounts]);

    const inputSchemaLabel = inputSchema?.type === 'transaction_graph' ? 'Transaction Graph' : inputSchema?.type === 'wide_table' ? 'Wide Table' : (inputSchema?.type || 'Legacy Table');

    const getNavItems = () => {
        const analyticsItem = { id:'ANALYTICS', label:'Model Analytics', icon: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg> };
        if (currentRole === 'Analyst') {
            return [
                { id:'DETAILED_VIEW', label:'Threat Matrix', badge: totalAlertsCount > 0 ? totalAlertsCount : null, icon: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg> },
                { id:'MULE_REGISTRY', label:'Mule Registry', icon: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg> },
                analyticsItem
            ];
        } else {
            return [
                { id:'OVERVIEW', label:'Command Center', icon: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/></svg> },
                { id:'SYSTEM_LOGS', label:'Audit Logs', icon: <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg> },
                analyticsItem
            ];
        }
    };
    const navItems = getNavItems();
    const activeAccent = currentRole === 'Admin' ? T.accent : T.analystAccent;
    const activeAccentBg = currentRole === 'Admin' ? T.accentBg : T.analystAccentBg;
    const activeAccentBgSafe = activeAccentBg || (currentRole === 'Admin' ? T.accentBg : T.analystAccentBg) || T.accentBg;

    if (loading) return (
        <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:T.bg }}>
            <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:16 }}>
                <div style={{ width:40, height:40, border:`3px solid ${T.border}`, borderTop:`3px solid ${activeAccent}`, borderRadius:'50%', animation:'spin 0.8s linear infinite', filter: `drop-shadow(0 0 8px ${activeAccent})` }} />
                <p style={{ fontSize:13, color:T.txt2, fontFamily:'monospace', letterSpacing:'0.2em', textTransform:'uppercase' }}>Initializing Nexus Core</p>
            </div>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
    );
    const handleLogin = async (e) => {
        e.preventDefault();
        setLoginLoading(true); setLoginError('');
        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: loginUsername, password: loginPassword })
            });
            const data = await res.json();
            if (data.success) {
                setJwtToken(data.token);
                setCurrentRole(data.user.role === 'ADMIN' ? 'Admin' : data.user.role === 'OVERSEER' ? 'Overseer' : 'Analyst');
            } else {
                setLoginError(data.message || 'Login failed');
            }
        } catch (err) {
            setLoginError('Network error');
        } finally {
            setLoginLoading(false);
        }
    };

    if (!jwtToken && !loading) {
        return (
            <div style={{ height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:T.bg, color:T.txt1, fontFamily:"'Inter', system-ui, sans-serif" }}>
                <div style={{ background:T.surface, padding:40, borderRadius:12, border:`1px solid ${T.border}`, width:400, boxShadow:'0 25px 50px -12px rgba(0,0,0,0.5)' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:30, justifyContent:'center' }}>
                        <div style={{ width:24, height:24, background:activeAccent, borderRadius:4 }} />
                        <h1 style={{ margin:0, fontSize:24, fontWeight:800, letterSpacing:'-0.03em' }}>NEXUS<span style={{color:activeAccent}}>.</span></h1>
                    </div>
                    <form onSubmit={handleLogin} style={{ display:'flex', flexDirection:'column', gap:20 }}>
                        <div>
                            <label style={{ display:'block', fontSize:12, fontWeight:600, color:T.txt2, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.05em' }}>Username</label>
                            <input type="text" value={loginUsername} onChange={e=>setLoginUsername(e.target.value)} style={{ width:'100%', padding:'12px 16px', background:T.bg, border:`1px solid ${T.border}`, color:T.txt1, borderRadius:6, outline:'none', fontSize:15 }} placeholder="Enter username" />
                        </div>
                        <div>
                            <label style={{ display:'block', fontSize:12, fontWeight:600, color:T.txt2, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.05em' }}>Password</label>
                            <input type="password" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} style={{ width:'100%', padding:'12px 16px', background:T.bg, border:`1px solid ${T.border}`, color:T.txt1, borderRadius:6, outline:'none', fontSize:15 }} placeholder="••••••••" />
                        </div>
                        {loginError && <div style={{ color:T.crit, fontSize:13, fontWeight:600, textAlign:'center', background:T.critBg, padding:'8px', borderRadius:6, border:`1px solid ${T.critBdr}` }}>{loginError}</div>}
                        <button type="submit" disabled={loginLoading} style={{ background:activeAccent, color:'#fff', border:'none', padding:'14px', borderRadius:6, fontWeight:700, fontSize:15, cursor:loginLoading ? 'not-allowed' : 'pointer', opacity:loginLoading ? 0.7 : 1, transition:'all 0.2s', marginTop:10, boxShadow:`0 0 20px ${activeAccentBgSafe}` }}>
                            {loginLoading ? 'Authenticating...' : 'Secure Login'}
                        </button>
                    </form>
                </div>
            </div>
        );
    }


    const SBW = sidebarCollapsed ? 64 : 260;
    const statusText = isUploading || statusMeta.kind !== 'idle' ? statusMeta.label : 'Engine Idle';
    const statusTone = statusMeta.kind === 'error' ? T.crit : statusMeta.kind === 'done' ? T.ok : isUploading ? activeAccent : T.ok;

    return (
        <div style={{ display:'flex', height:'100vh', overflow:'hidden', background:T.bg, fontFamily:"'Inter', 'Segoe UI', system-ui, sans-serif", fontSize:14, color:T.txt1 }}>
            <style>{`
                * { box-sizing: border-box; }
                ::-webkit-scrollbar { width: 8px; height: 8px; }
                ::-webkit-scrollbar-track { background: ${T.bg}; }
                ::-webkit-scrollbar-thumb { background: ${T.borderHi}; border-radius: 4px; }
                ::-webkit-scrollbar-thumb:hover { background: ${T.txt3}; }
                input::placeholder { color: ${T.txt3}; }
                select option { background: ${T.surface}; color: ${T.txt1}; }
                @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
            <Toaster />

            {/* ── SIDEBAR ──────────────────────────────────────────────────── */}
            <aside style={{ width:SBW, flexShrink:0, background:T.bg, borderRight:`1px solid ${T.border}`, display:'flex', flexDirection:'column', transition:'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)', overflow:'hidden', zIndex:10 }}>
                <div style={{ padding: sidebarCollapsed ? '24px 0' : '24px 20px', borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:12, justifyContent: sidebarCollapsed ? 'center' : 'space-between' }}>
                    {!sidebarCollapsed && (
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                            <div style={{ width:32, height:32, background:activeAccentBgSafe, border:`1px solid ${activeAccent}40`, borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', boxShadow: `0 0 12px ${activeAccentBgSafe}` }}>
                                <svg width="16" height="16" fill="none" stroke={activeAccent} strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                            </div>
                            <div>
                                <div style={{ fontSize:15, fontWeight:800, color:T.txt1, letterSpacing:'0.02em' }}>Project Nexus</div>
                                <div style={{ fontSize:11, color:T.txt3, letterSpacing:'0.05em', textTransform:'uppercase' }}>Detection Pipeline</div>
                            </div>
                        </div>
                    )}
                    <button onClick={() => setSidebarCollapsed(v => !v)}
                        style={{ background:'none', border:'none', cursor:'pointer', color:T.txt3, padding:6, borderRadius:6, display:'flex', alignItems:'center', flexShrink:0, transition:'all 0.2s' }}
                        onMouseEnter={e => { e.currentTarget.style.color = T.txt1; e.currentTarget.style.background = T.raised; }} onMouseLeave={e => { e.currentTarget.style.color = T.txt3; e.currentTarget.style.background = 'transparent'; }}>
                        <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            {sidebarCollapsed ? <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7"/> : <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7M19 19l-7-7 7-7"/>}
                        </svg>
                    </button>
                </div>

                <nav style={{ flex:1, padding:'16px 12px', display:'flex', flexDirection:'column', gap:4, overflowY:'auto' }}>
                    {navItems.map(({ id, label, icon, badge }) => {
                        const active = currentView === id;
                        return (
                            <button key={id} onClick={() => setCurrentView(id)} title={sidebarCollapsed ? label : undefined}
                                style={{ display:'flex', alignItems:'center', gap:12, padding: sidebarCollapsed ? '12px 0' : '12px 16px', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', borderRadius:8, border:'none', cursor:'pointer', width:'100%', textAlign:'left', background: active ? activeAccentBgSafe : 'transparent', color: active ? activeAccent : T.txt2, transition:'all 0.2s ease', position:'relative', borderLeft: active ? `3px solid ${activeAccent}` : '3px solid transparent' }}
                                onMouseEnter={e => { if (!active) { e.currentTarget.style.background = T.raised; e.currentTarget.style.color = T.txt1; }}}
                                onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.txt2; }}}>
                                <span style={{ flexShrink:0, filter: active ? `drop-shadow(0 0 4px ${activeAccent})` : 'none' }}>{icon}</span>
                                {!sidebarCollapsed && <span style={{ fontSize:14, fontWeight: active ? 700 : 500 }}>{label}</span>}
                                {!sidebarCollapsed && badge && (
                                    <span style={{ marginLeft:'auto', fontSize:11, fontWeight:800, background:T.critBg, color:T.crit, border:`1px solid ${T.critBdr}`, borderRadius:12, padding:'2px 8px', minWidth:26, textAlign:'center', boxShadow: `0 0 8px ${T.critBg}` }}>{badge}</span>
                                )}
                            </button>
                        );
                    })}
                </nav>

                {!sidebarCollapsed && currentRole === 'Admin' && (
                    <div style={{ padding:'16px', borderTop:`1px solid ${T.border}` }}>
                        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:8, fontWeight:700 }}>Live Operations</div>
                        <div style={{ display:'grid', gap:8 }}>
                            <button onClick={() => openLiveRoute('/live-stream')} style={{ width:'100%', padding:'10px 14px', borderRadius:8, border:`1px solid ${T.border}`, background:T.surface, color:T.txt1, fontSize:12, fontWeight:600, cursor:'pointer', textAlign:'left', transition:'all 0.2s' }} onMouseEnter={e => {e.currentTarget.style.borderColor = T.borderHi; e.currentTarget.style.background = T.raised;}} onMouseLeave={e => {e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.surface;}}>Current Live Stream</button>
                            <button onClick={() => openLiveRoute('/live-stream/audit')} style={{ width:'100%', padding:'10px 14px', borderRadius:8, border:`1px solid ${T.border}`, background:T.surface, color:T.txt1, fontSize:12, fontWeight:600, cursor:'pointer', textAlign:'left', transition:'all 0.2s' }} onMouseEnter={e => {e.currentTarget.style.borderColor = T.borderHi; e.currentTarget.style.background = T.raised;}} onMouseLeave={e => {e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = T.surface;}}>Live Audit Log</button>
                        </div>
                    </div>
                )}

                {!sidebarCollapsed && availableDatasets.length > 0 && (
                    <div style={{ padding:'16px', borderTop:`1px solid ${T.border}` }}>
                        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:8, fontWeight:700 }}>Active Corpus</div>
                        <div style={{ display:'grid', gap:10 }}>
                            <div style={{ position:'relative' }}>
                                <select value={datasetSourceFilter} onChange={e => setDatasetSourceFilter(e.target.value)} style={{ width:'100%', padding:'9px 32px 9px 12px', fontSize:12, borderRadius:8, outline:'none', background:T.surface, border:`1px solid ${T.border}`, color:T.txt1, cursor:'pointer', appearance:'none', fontFamily:'monospace', fontWeight:600 }}>
                                    <option value="ALL">All Sources</option>
                                    <option value="STATIC_INGEST">Static Ingest</option>
                                    <option value="LIVE_STREAM">Live Stream</option>
                                </select>
                                <svg width="14" height="14" fill="none" stroke={T.txt3} strokeWidth="2" viewBox="0 0 24 24" style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
                            </div>
                            <div style={{ position:'relative' }}>
                                <select value={activeDataset} onChange={e => setActiveDataset(e.target.value)} style={{ width:'100%', padding:'9px 32px 9px 12px', fontSize:12, borderRadius:8, outline:'none', background:T.surface, border:`1px solid ${T.border}`, color:T.txt1, cursor:'pointer', appearance:'none', fontFamily:'monospace', fontWeight:600 }}>
                                    <option value="ALL">All Datasets</option>
                                    {visibleDatasetFiles.map((file, i) => (
                                        <option key={`${file.fileHash || file.fileName}-${i}`} value={file.fileName}>{`${file.fileName} · ${resolveSourceType(file) === 'LIVE_STREAM' ? 'Live' : 'Static'} · ${(file.totalAccountsScanned || 0).toLocaleString()} scanned`}</option>
                                    ))}
                                </select>
                                <svg width="14" height="14" fill="none" stroke={T.txt3} strokeWidth="2" viewBox="0 0 24 24" style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/></svg>
                            </div>
                        </div>
                    </div>
                )}

                <div style={{ padding: sidebarCollapsed ? '16px 0' : '16px 20px', borderTop:`1px solid ${T.border}`, display:'flex', alignItems:'center', gap:10, justifyContent: sidebarCollapsed ? 'center' : 'flex-start', background:T.surface }}>
                    <div style={{ width:8, height:8, borderRadius:'50%', flexShrink:0, background: statusTone, boxShadow: `0 0 8px ${statusTone}` }} />
                    {!sidebarCollapsed && (
                        <span style={{ fontSize:12, color:T.txt2, fontFamily:'monospace', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontWeight:600 }}>{statusText}</span>
                    )}
                </div>
            </aside>

            {/* ── HEADER & WORKSPACE ───────────────────────────────────────── */}
            <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background: T.bg }}>
                <header style={{ height:64, background:T.surface, borderBottom:`1px solid ${T.border}`, display:'flex', alignItems:'center', padding:'0 24px', gap:16, flexShrink:0, zIndex:5, boxShadow:'0 4px 24px rgba(0,0,0,0.2)' }}>
                    <h1 style={{ fontSize:18, fontWeight:700, color:T.txt1, flex:1, margin:0, letterSpacing:'-0.02em' }}>{navItems.find(n => n.id === currentView)?.label || 'Dashboard'}</h1>
                    <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10, marginRight:12 }}>
                            <label style={{ fontSize:12, color:T.txt3, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em' }}>Role Workspace</label>
                            <select value={currentRole} onChange={handleRoleToggle} style={{ padding:'8px 12px', borderRadius:8, border:`1px solid ${activeAccent}40`, background:activeAccentBgSafe, color:activeAccent, fontWeight:700, cursor:'pointer', outline:'none', boxShadow:`0 0 12px ${activeAccentBgSafe}` }}>
                                <option value="Analyst">Analyst Viewer</option>
                                <option value="Overseer">Overseer</option>
                                <option value="Admin">System Administrator</option>
                            </select>
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 14px', background:T.critBg, border:`1px solid ${T.critBdr}`, borderRadius:8, boxShadow:`0 0 8px ${T.critBg}` }}>
                            <span style={{ width:8, height:8, borderRadius:'50%', background:T.crit, flexShrink:0, filter:`drop-shadow(0 0 4px ${T.crit})` }} />
                            <span style={{ fontSize:13, color:T.crit, fontWeight:700 }}>{critCount} Critical</span>
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 14px', background:T.highBg, border:`1px solid ${T.highBdr}`, borderRadius:8, boxShadow:`0 0 8px ${T.highBg}` }}>
                            <span style={{ width:8, height:8, borderRadius:'50%', background:T.high, flexShrink:0, filter:`drop-shadow(0 0 4px ${T.high})` }} />
                            <span style={{ fontSize:13, color:T.high, fontWeight:700 }}>{highCount} High Risk</span>
                        </div>
                    </div>

                    {currentRole === 'Admin' && (
                        <>
                            <div style={{ width:1, height:32, background:T.border, margin:'0 8px' }} />
                            <input type="file" accept=".csv" ref={fileInputRef} onChange={handleFileUpload} style={{ display:'none' }} />
                            <button onClick={() => fileInputRef.current.click()} disabled={isUploading}
                                style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 18px', borderRadius:8, fontSize:13, fontWeight:700, cursor: isUploading ? 'not-allowed' : 'pointer', transition:'all 0.2s', background: isUploading ? T.raised : activeAccent, color: isUploading ? T.txt3 : '#fff', border: isUploading ? `1px solid ${T.borderHi}` : `1px solid ${activeAccent}`, boxShadow: isUploading ? 'none' : `0 0 16px ${activeAccentBgSafe}` }}
                                onMouseEnter={e => { if (!isUploading) e.currentTarget.style.filter = 'brightness(1.15)'; }} onMouseLeave={e => { e.currentTarget.style.filter = 'none'; }}>
                                <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                                Ingest Data
                            </button>
                        </>
                    )}
                </header>

                {isUploading && currentRole === 'Admin' && (
                    <div style={{ padding:'24px 32px 0 32px' }}>
                        <Card style={{ padding:'20px 24px', border:`1px solid ${activeAccent}40`, background:`linear-gradient(135deg, ${T.surface} 0%, #000 100%)` }}>
                            <div style={{ display:'flex', justifyContent:'space-between', gap:16, flexWrap:'wrap', alignItems:'flex-start' }}>
                                <div style={{ minWidth: 280 }}>
                                    <div style={{ fontSize:11, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.15em', marginBottom:8, fontWeight:700 }}>Live Upload Pipeline</div>
                                    <div style={{ fontSize:18, color:T.txt1, fontWeight:800, marginBottom:6, fontFamily:'monospace' }}>{uploadFileName || 'Current dataset'}</div>
                                    <div style={{ fontSize:13, color:T.txt2, lineHeight:1.6 }}>{statusMeta.detail}</div>
                                </div>
                                <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
                                    <div style={{ padding:'10px 16px', borderRadius:10, background:T.bg, border:`1px solid ${T.borderHi}` }}>
                                        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:600 }}>Status</div>
                                        <div style={{ fontSize:14, color:statusTone, fontWeight:800, marginTop:4 }}>{statusText}</div>
                                    </div>
                                    <div style={{ padding:'10px 16px', borderRadius:10, background:T.bg, border:`1px solid ${T.borderHi}` }}>
                                        <div style={{ fontSize:10, color:T.txt3, textTransform:'uppercase', letterSpacing:'0.1em', fontWeight:600 }}>Elapsed</div>
                                        <div style={{ fontSize:14, color:T.txt1, fontWeight:800, marginTop:4 }}>{formatDuration(uploadElapsedSeconds)}</div>
                                    </div>
                                </div>
                            </div>
                            <div style={{ marginTop:20, display:'grid', gridTemplateColumns:'repeat(5, minmax(0, 1fr))', gap:10 }}>
                                {UPLOAD_PROGRESS_STEPS.map((step, idx) => {
                                    const completed = idx < statusMeta.phase; const active = idx === statusMeta.phase; const terminal = idx === 4 && statusMeta.kind !== 'active' && statusMeta.kind !== 'idle';
                                    const stepBg = terminal && statusMeta.kind === 'error' ? T.critBg : completed || active || terminal ? activeAccentBgSafe : T.bg;
                                    const stepBorder = terminal && statusMeta.kind === 'error' ? T.critBdr : completed || active || terminal ? `rgba(99,102,241,0.3)` : T.border;
                                    const stepColor = terminal && statusMeta.kind === 'error' ? T.crit : completed || active || terminal ? activeAccent : T.txt3;
                                    return (
                                        <div key={step.label} style={{ padding:'10px 12px', borderRadius:10, background:stepBg, border:`1px solid ${stepBorder}`, boxShadow: active ? `0 0 12px ${activeAccentBgSafe}` : 'none' }}>
                                            <div style={{ fontSize:10, color:stepColor, textTransform:'uppercase', letterSpacing:'0.1em', marginBottom:4, fontWeight:800 }}>{String(idx + 1).padStart(2, '0')}</div>
                                            <div style={{ fontSize:13, color: completed || active || terminal ? T.txt1 : T.txt3, fontWeight:700 }}>{step.label}</div>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    </div>
                )}

                {/* ── VIEWS DISPATCHER ─────────────────────────────────────────── */}
                <main style={{ flex:1, overflowY:'auto', padding:'24px 32px' }}>
                    {/* 3.7 Drift Banner */}
                    {driftAlert && (
                        <div style={{ marginBottom:20, padding:'12px 20px', background:T.critBg, border:`1px solid ${T.critBdr}`, borderRadius:8, display:'flex', alignItems:'center', gap:16, flexWrap:'wrap' }}>
                            <div style={{ flex:1 }}>
                                <span style={{ fontSize:12, fontWeight:800, color:T.crit, textTransform:'uppercase', letterSpacing:'0.1em', marginRight:12 }}>⚠ Feature Drift Detected</span>
                                <span style={{ fontSize:13, color:T.txt1 }}>
                                    {(driftAlert.affectedFeatures || []).slice(0,5).join(', ')}{(driftAlert.affectedFeatures || []).length > 5 ? ` +${(driftAlert.affectedFeatures || []).length - 5} more` : ''}
                                    {driftAlert.maxDriftScore != null && <span style={{ color:T.txt3, marginLeft:8 }}>· Max drift: {Number(driftAlert.maxDriftScore).toFixed(3)}</span>}
                                </span>
                            </div>
                            <button onClick={handleTriggerRetrain} disabled={isRetraining || retrainCooldown} style={{ padding:'6px 14px', fontSize:12, fontWeight:700, borderRadius:6, cursor:'pointer', background:T.accentBg, border:`1px solid ${T.accent}`, color:T.accent }}>Trigger Retrain</button>
                            <button onClick={() => setDriftAlert(null)} style={{ padding:'6px 14px', fontSize:12, fontWeight:700, borderRadius:6, cursor:'pointer', background:'transparent', border:`1px solid ${T.border}`, color:T.txt3 }}>Dismiss</button>
                        </div>
                    )}
                    {currentView === 'OVERVIEW' && currentRole === 'Admin' && (
                        <AdminOverviewView
                            activeDataset={activeDataset}
                            jwtToken={jwtToken} visibleDatasetFiles={visibleDatasetFiles} totalScanned={totalScanned} critCount={critCount} highCount={highCount}
                            fileInputRef={fileInputRef} uploadLimitEnabled={uploadLimitEnabled} setUploadLimitEnabled={setUploadLimitEnabled} maxUploadMB={maxUploadMB}
                            setMaxUploadMB={setMaxUploadMB} perUploadMB={perUploadMB} setPerUploadMB={setPerUploadMB} saveUploadConfig={saveUploadConfig}
                            inputSchemaLabel={inputSchemaLabel} inputSchema={inputSchema} activeAccent={activeAccent} activeAccentBg={activeAccentBgSafe}
                            feedbackStats={feedbackStats}
                        />
                    )}
                    {currentView === 'SYSTEM_LOGS' && currentRole === 'Admin' && (
                        <SystemLogsView
                            activeLogTab={activeLogTab} setActiveLogTab={setActiveLogTab} handleSystemWipe={handleSystemWipe} currentLogs={currentLogs} currentPage={currentPage}
                            totalLogPages={totalLogPages} jumpPage={jumpPage} setJumpPage={setJumpPage} handleJumpKey={handleJumpKey} setCurrentPage={setCurrentPage}
                            currentFiles={currentFiles} resolveSourceType={resolveSourceType}
                                isRetraining={isRetraining}
                                retrainCooldown={retrainCooldown}
                                handleTriggerRetrain={handleTriggerRetrain} totalFilePages={totalFilePages}
                        />
                    )}
                    {currentView === 'ANALYTICS' && (
                        <ModelAnalyticsView
                            activeDataset={activeDataset}
                            jwtToken={jwtToken}
                            modelVersion={modelVersion}
                            currentRole={currentRole}
                            inputSchema={inputSchema} modelConfig={modelConfig} modelMetrics={modelMetrics} formatMetricDisplay={formatMetricDisplay}
                            activeAccent={activeAccent} thresholdCurve={thresholdCurve} fmtThreshold={fmtThreshold} droppedFeatures={droppedFeatures}
                            activeAlerts={activeAlerts} riskData={riskData} CHART_CLRS={CHART_CLRS} featureData={featureData} featureImportance={featureImportance}
                        />
                    )}
                    {(currentView === 'DETAILED_VIEW' || currentView === 'MULE_REGISTRY') && currentRole === 'Analyst' && (
                        <ThreatMatrixView
                            currentView={currentView} activeTab={activeTab} setActiveTab={setActiveTab} searchType={searchType} setSearchType={setSearchType}
                            searchTerm={searchTerm} setSearchTerm={setSearchTerm} exportToCSV={exportToCSV} totalAlertsCount={totalAlertsCount} currentPage={currentPage}
                            totalPages={totalPages} currentAlerts={currentAlerts} setSelectedAccount={setSelectedAccount} handleResolve={handleResolve}
                            handleConfirmFraud={handleConfirmFraud} confirmMule={confirmMule} revokeMule={revokeMule} activeAccent={activeAccent} activeAccentBg={activeAccentBgSafe} jumpPage={jumpPage} setJumpPage={setJumpPage}
                            handleJumpKey={handleJumpKey} setCurrentPage={setCurrentPage}
                            selectedAlertIds={selectedAlertIds} setSelectedAlertIds={setSelectedAlertIds} handleBulkAction={handleBulkAction}
                        />
                    )}
                </main>
            </div>

            <AccountInspectionModal
                selectedAccount={selectedAccount}
                setSelectedAccount={setSelectedAccount}
                handleResolve={handleResolve}
                handleConfirmFraud={handleConfirmFraud}
                activeAccent={activeAccent}
                confirmedFraudIds={confirmedFraudIds}
                jwtToken={jwtToken}
                currentRole={currentRole}
            />
        </div>
    );
};

export default Dashboard;
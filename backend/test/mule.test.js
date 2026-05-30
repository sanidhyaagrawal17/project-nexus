const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongoServer;
let app;
let Alert;

beforeAll(async () => {
  jest.setTimeout(30000);
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();
  process.env.NODE_ENV = 'test';

  // require server after env set
  const serverModule = require('../server');
  app = serverModule.app;
  // bootstrap connects mongoose in test mode
  if (serverModule && serverModule.bootstrap) await serverModule.bootstrap();

  Alert = require('../models/Alert');
});

afterAll(async () => {
  try {
    await mongoose.connection.dropDatabase();
    await mongoose.connection.close();
    if (mongoServer) await mongoServer.stop();
  } catch (e) { /* ignore */ }
});

describe('RBAC and Mule endpoint', () => {
  test('Admin-only endpoint rejects non-admin', async () => {
    const res = await request(app).post('/api/upload-config').send({ maxUploadMB: 50 });
    expect(res.status).toBe(403);
    expect(res.body && res.body.success).toBe(false);
  });

  test('PUT /api/alerts/:id/mule updates muleStatus for Analyst', async () => {
    // create an alert document
    const a = await Alert.create({
      accountId: 'acct-123', riskScore: 55.5, anomalyScore: 12, topFeatures: [], sourceFileName: 'test.csv', status: 'High Risk', detectedAt: new Date(), rawTelemetry: { msg: 'test' }
    });

    const res = await request(app)
      .put(`/api/alerts/${a._id}/mule`)
      .set('X-User-Role', 'Analyst')
      .set('Accept', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ muleStatus: 'Confirmed Mule' });

    expect(res.status).toBe(200);
    expect(res.body && res.body.success).toBe(true);
    expect(res.body.data && res.body.data.muleStatus).toBe('Confirmed Mule');
  });

  test('PUT /api/alerts/:id/mule rejects invalid status', async () => {
    const a = await Alert.create({
      accountId: 'acct-400', riskScore: 22, anomalyScore: 3, topFeatures: [], sourceFileName: 'test.csv', status: 'High Risk', detectedAt: new Date(), rawTelemetry: { msg: 't2' }
    });
    const res = await request(app)
      .put(`/api/alerts/${a._id}/mule`)
      .set('X-User-Role', 'Analyst')
      .set('Accept', 'application/json')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({ muleStatus: 'INVALID_STATUS' });
    expect(res.status).toBe(400);
  });
});

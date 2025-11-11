import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from './server.js';

describe('Backend API Health Endpoints', () => {
  beforeEach(() => {
    // Set test environment variables
    process.env.SECRET = 'test-secret-for-testing';
    process.env.NODE_ENV = 'test';
  });

  it('GET /health should return 200 and status ok', async () => {
    const res = await request(app)
      .get('/health')
      .expect(200);
    
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('time');
  });

  it('GET /healthz should return 200 and status ok', async () => {
    const res = await request(app)
      .get('/healthz')
      .expect(200);
    
    expect(res.body).toHaveProperty('status');
    expect(res.body.status).toBe('ok');
    expect(res.body).toHaveProperty('uptime');
  });

  it('GET /api/attendance without auth should return 401', async () => {
    const res = await request(app)
      .get('/api/attendance')
      .expect(401);
    
    expect(res.body).toHaveProperty('error');
  });

  it('POST /api/login without credentials should return 400', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({})
      .expect(400);
    
    expect(res.body).toHaveProperty('errors');
  });
});

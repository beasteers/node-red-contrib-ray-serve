CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE data (
    time TIMESTAMPTZ,
    route TEXT,
    inputPayload TEXT,
    payload TEXT,
    rayQueueCountCurrent INTEGER,
    rayQueueCountBacklog INTEGER,
    responseTime INTEGER,
    fcount INTEGER,
    rejectionCause TEXT,
    nReplicas INTEGER
);

select create_hypertable('data', 'time');
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE data (
    time TIMESTAMPTZ,
    route TEXT,
    inputPayload TEXT,
    payload TEXT,
    rayQueueCountCurrent INTEGER,
    rayQueueCountBacklog INTEGER
);

select create_hypertable('data', 'time');

-- CREATE TABLE data2 (
--     time BIGINT,
--     route TEXT,
--     inputPayload text,
--     payload text,
--     rayQueueCountCurrent INTEGER,
--     rayQueueCountBacklog INTEGER
-- );

-- \copy data2 from 'data/output.csv'  WITH CSV HEADER;

-- -- TRUNCATE data;
-- INSERT INTO data (time, route, inputPayload, payload, rayQueueCountCurrent, rayQueueCountBacklog)
-- SELECT to_timestamp(time/1000.0), route, inputPayload, payload, rayQueueCountCurrent, rayQueueCountBacklog
-- FROM data2;
-- drop table data2;
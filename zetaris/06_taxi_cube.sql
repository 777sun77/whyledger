-- taxi_zones ships each zone 3 times, so join a DISTINCT copy (otherwise trips triple-count)
CREATE OR REPLACE SCHEMASTORE VIEW taxi_cube WITH CONTAINER whyledger AS
SELECT substr(y.tpep_pickup_datetime, 1, 7) AS month,
       COALESCE(z.borough, 'Unknown') AS borough,
       CASE y.payment_type WHEN '1' THEN 'credit card' WHEN '2' THEN 'cash' WHEN '0' THEN 'flex/unknown' WHEN '3' THEN 'no charge' WHEN '4' THEN 'dispute' ELSE 'other' END AS payment,
       CASE WHEN CAST(y.trip_distance AS DOUBLE) < 1 THEN '0-1 mi' WHEN CAST(y.trip_distance AS DOUBLE) < 3 THEN '1-3 mi' WHEN CAST(y.trip_distance AS DOUBLE) < 10 THEN '3-10 mi' ELSE '10+ mi' END AS distance_band,
       CASE WHEN COALESCE(CAST(y.Airport_fee AS DOUBLE), 0) > 0 OR y.RatecodeID IN ('2', '3') THEN 'airport' ELSE 'non-airport' END AS airport,
       CASE WHEN CAST(substr(y.tpep_pickup_datetime, 12, 2) AS INT) BETWEEN 6 AND 9 THEN 'morning peak' WHEN CAST(substr(y.tpep_pickup_datetime, 12, 2) AS INT) BETWEEN 16 AND 19 THEN 'evening peak' WHEN CAST(substr(y.tpep_pickup_datetime, 12, 2) AS INT) BETWEEN 10 AND 15 THEN 'midday' ELSE 'night' END AS time_band,
       COUNT(*) AS trips, SUM(CAST(y.total_amount AS DOUBLE)) AS revenue, SUM(CAST(y.fare_amount AS DOUBLE)) AS fares,
       SUM(COALESCE(CAST(y.congestion_surcharge AS DOUBLE), 0)) AS congestion_fees
FROM NY_TAXI.yellow_taxi y
LEFT JOIN (SELECT DISTINCT LocationID, borough FROM NY_TAXI.taxi_zones) z ON z.LocationID = y.PULocationID
WHERE substr(y.tpep_pickup_datetime, 1, 4) IN ('2024', '2025')
GROUP BY 1, 2, 3, 4, 5, 6

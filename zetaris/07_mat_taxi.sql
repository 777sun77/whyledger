CREATE LIGHTNING FILESTORE TABLE taxi_cube FROM WHYLEDGER_MART FORMAT PARQUET OPTIONS (
  path "/home/zetaris/customer-data/shared/whyledger/taxi_cube",
  sourceTable "whyledger.taxi_cube"
)

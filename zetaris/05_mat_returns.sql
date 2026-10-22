CREATE LIGHTNING FILESTORE TABLE returns_cube FROM WHYLEDGER_MART FORMAT PARQUET OPTIONS (
  path "/home/zetaris/customer-data/shared/whyledger/returns_cube",
  sourceTable "whyledger.returns_cube"
)

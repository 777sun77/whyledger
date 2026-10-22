CREATE LIGHTNING FILESTORE TABLE sales_cube FROM WHYLEDGER_MART FORMAT PARQUET OPTIONS (
  path "/home/zetaris/customer-data/shared/whyledger/sales_cube",
  sourceTable "whyledger.sales_cube"
)

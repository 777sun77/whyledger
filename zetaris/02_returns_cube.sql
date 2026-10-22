CREATE OR REPLACE SCHEMASTORE VIEW returns_cube WITH CONTAINER whyledger AS
SELECT d.d_year AS yr, d.d_qoy AS qoy, x.channel, COALESCE(i.i_category, 'unknown') AS category,
       COALESCE(ca.ca_state, 'unknown') AS state, SUM(x.amt) AS return_amt, COUNT(*) AS lines
FROM (
  SELECT 'store' AS channel, sr_returned_date_sk AS dk, sr_item_sk AS ik, sr_addr_sk AS ak, sr_return_amt AS amt FROM TPCDS_DB.store_returns
  UNION ALL SELECT 'web', wr_returned_date_sk, wr_item_sk, wr_refunded_addr_sk, wr_return_amt FROM TPCDS_DB.web_returns
  UNION ALL SELECT 'catalog', cr_returned_date_sk, cr_item_sk, cr_refunded_addr_sk, cr_return_amount FROM TPCDS_DB.catalog_returns
) x
JOIN TPCDS_DB.date_dim d ON d.d_date_sk = x.dk
LEFT JOIN TPCDS_DB.item i ON i.i_item_sk = x.ik
LEFT JOIN TPCDS_DB.customer_address ca ON ca.ca_address_sk = x.ak
GROUP BY d.d_year, d.d_qoy, x.channel, COALESCE(i.i_category, 'unknown'), COALESCE(ca.ca_state, 'unknown')

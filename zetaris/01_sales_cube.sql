CREATE OR REPLACE SCHEMASTORE VIEW sales_cube WITH CONTAINER whyledger AS
SELECT d.d_year AS yr, d.d_qoy AS qoy, x.channel, COALESCE(i.i_category, 'unknown') AS category,
       COALESCE(ca.ca_state, 'unknown') AS state, COALESCE(cd.cd_education_status, 'unknown') AS education,
       x.promoted, SUM(x.amt) AS revenue, SUM(x.qty) AS units, COUNT(*) AS lines
FROM (
  SELECT 'store' AS channel, ss_sold_date_sk AS dk, ss_item_sk AS ik, ss_addr_sk AS ak, ss_cdemo_sk AS ck,
         CASE WHEN ss_promo_sk IS NULL THEN 'no promotion' ELSE 'promoted' END AS promoted, ss_net_paid AS amt, ss_quantity AS qty
  FROM TPCDS_DB.store_sales
  UNION ALL
  SELECT 'web', ws_sold_date_sk, ws_item_sk, ws_bill_addr_sk, ws_bill_cdemo_sk,
         CASE WHEN ws_promo_sk IS NULL THEN 'no promotion' ELSE 'promoted' END, ws_net_paid, ws_quantity
  FROM TPCDS_DB.web_sales
  UNION ALL
  SELECT 'catalog', cs_sold_date_sk, cs_item_sk, cs_bill_addr_sk, cs_bill_cdemo_sk,
         CASE WHEN cs_promo_sk IS NULL THEN 'no promotion' ELSE 'promoted' END, cs_net_paid, cs_quantity
  FROM TPCDS_DB.catalog_sales
) x
JOIN TPCDS_DB.date_dim d ON d.d_date_sk = x.dk
LEFT JOIN TPCDS_DB.item i ON i.i_item_sk = x.ik
LEFT JOIN TPCDS_DB.customer_address ca ON ca.ca_address_sk = x.ak
LEFT JOIN TPCDS_DB.customer_demographics cd ON cd.cd_demo_sk = x.ck
GROUP BY d.d_year, d.d_qoy, x.channel, COALESCE(i.i_category, 'unknown'), COALESCE(ca.ca_state, 'unknown'), COALESCE(cd.cd_education_status, 'unknown'), x.promoted

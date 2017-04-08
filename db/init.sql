DROP DATABASE IF EXISTS ricca_pay;
CREATE DATABASE ricca_pay DEFAULT CHARACTER SET = utf8;
DROP TABLE IF EXISTS ricca_pay.account;
DROP TABLE IF EXISTS ricca_pay.debt;
DROP TABLE IF EXISTS ricca_pay.transaction;
CREATE TABLE ricca_pay.account (
  slack_id CHAR(9) NOT NULL,
  passphrase VARCHAR(255) NOT NULL, -- FIXME: to be encrypted
  role ENUM('user', 'admin') NOT NULL,
  PRIMARY KEY (slack_id)
) DEFAULT CHARACTER SET = utf8;
CREATE TABLE ricca_pay.debt (
  id SMALLINT NOT NULL AUTO_INCREMENT,
  ts DATETIME(6) NOT NULL,
  debtor_id CHAR(9) NOT NULL,
  creditor_id CHAR(9) NOT NULL CHECK(creditor_id <> debtor_id),
  item VARCHAR(127) NOT NULL,
  amount SMALLINT NOT NULL,
  key_currency VARCHAR(3) NOT NULL DEFAULT 'JPY',
  status ENUM('claimed', 'approved', 'rejected') NOT NULL,
  CONSTRAINT fk_debtor_id
    FOREIGN KEY (debtor_id) REFERENCES ricca_pay.account (slack_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_creditor_id
    FOREIGN KEY (creditor_id) REFERENCES ricca_pay.account (slack_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (id)
) DEFAULT CHARACTER SET = utf8;

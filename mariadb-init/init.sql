CREATE DATABASE IF NOT EXISTS dailysync CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'dailysync'@'%' IDENTIFIED BY 'dailysync_pass';
GRANT ALL PRIVILEGES ON dailysync.* TO 'dailysync'@'%';
FLUSH PRIVILEGES;

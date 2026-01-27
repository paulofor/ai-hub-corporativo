ALTER TABLE upload_jobs
    ADD COLUMN result_zip_ready TINYINT(1) NOT NULL DEFAULT 0 AFTER result_zip_filename;

UPDATE upload_jobs
SET result_zip_ready = CASE
    WHEN result_zip_base64 IS NOT NULL AND result_zip_base64 <> '' THEN 1
    ELSE 0
END;

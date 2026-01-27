ALTER TABLE upload_jobs
    ADD COLUMN result_zip_ready BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE upload_jobs
SET result_zip_ready = CASE
    WHEN result_zip_base64 IS NOT NULL AND result_zip_base64 <> '' THEN TRUE
    ELSE FALSE
END;

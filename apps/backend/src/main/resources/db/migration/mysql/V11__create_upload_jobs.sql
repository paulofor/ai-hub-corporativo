CREATE TABLE upload_jobs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(100) NOT NULL UNIQUE,
    task_description LONGTEXT NOT NULL,
    test_command TEXT,
    profile VARCHAR(50),
    model VARCHAR(200),
    zip_name VARCHAR(255),
    status VARCHAR(60) NOT NULL,
    summary LONGTEXT,
    error LONGTEXT,
    changed_files LONGTEXT,
    patch LONGTEXT,
    result_zip_base64 LONGTEXT,
    result_zip_filename VARCHAR(255),
    pull_request_url VARCHAR(500),
    prompt_tokens INT,
    cached_prompt_tokens INT,
    completion_tokens INT,
    total_tokens INT,
    cost DECIMAL(19,4),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_upload_jobs_created_at ON upload_jobs(created_at);

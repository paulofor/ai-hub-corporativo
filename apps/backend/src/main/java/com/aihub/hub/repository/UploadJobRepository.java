package com.aihub.hub.repository;

import com.aihub.hub.domain.UploadJobRecord;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;

public interface UploadJobRepository extends JpaRepository<UploadJobRecord, Long> {
    Optional<UploadJobRecord> findByJobId(String jobId);

    List<UploadJobRecord> findTop50ByOrderByCreatedAtDesc();
}

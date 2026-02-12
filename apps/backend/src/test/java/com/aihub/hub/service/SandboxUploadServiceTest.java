package com.aihub.hub.service;

import com.aihub.hub.domain.UploadJobRecord;
import com.aihub.hub.dto.UploadJobView;
import com.aihub.hub.repository.UploadJobRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SandboxUploadServiceTest {

    @Mock
    private SandboxOrchestratorClient sandboxOrchestratorClient;

    @Mock
    private AuditService auditService;

    @Mock
    private UploadJobRepository uploadJobRepository;

    @Mock
    private TokenCostCalculator tokenCostCalculator;

    private SandboxUploadService sandboxUploadService;

    @BeforeEach
    void setUp() {
        sandboxUploadService = new SandboxUploadService(
            sandboxOrchestratorClient,
            auditService,
            uploadJobRepository,
            8_388_608L,
            tokenCostCalculator,
            "gpt-5-codex",
            "gpt-5-codex"
        );
    }

    @Test
    void getJobRefreshShouldKeepCompletedStatusWhenOrchestratorReturnsNotFound() {
        UploadJobRecord record = new UploadJobRecord();
        record.setJobId("job-123");
        record.setTaskDescription("Corrigir build");
        record.setStatus("COMPLETED");
        record.setSummary("Resumo anterior");

        when(uploadJobRepository.findByJobId("job-123")).thenReturn(Optional.of(record));
        when(sandboxOrchestratorClient.getJob("job-123")).thenReturn(null);

        UploadJobView result = sandboxUploadService.getJob("job-123", true);

        assertThat(result.status()).isEqualTo("COMPLETED");
        assertThat(result.error()).isNull();
        assertThat(result.summary()).contains("último estado salvo localmente");

        ArgumentCaptor<UploadJobRecord> savedRecord = ArgumentCaptor.forClass(UploadJobRecord.class);
        verify(uploadJobRepository).save(savedRecord.capture());
        assertThat(savedRecord.getValue().getStatus()).isEqualTo("COMPLETED");
    }

    @Test
    void getJobRefreshShouldMarkFailedWhenNonTerminalAndOrchestratorReturnsNotFound() {
        UploadJobRecord record = new UploadJobRecord();
        record.setJobId("job-456");
        record.setTaskDescription("Rodar testes");
        record.setStatus("RUNNING");

        when(uploadJobRepository.findByJobId("job-456")).thenReturn(Optional.of(record));
        when(sandboxOrchestratorClient.getJob("job-456")).thenReturn(null);

        UploadJobView result = sandboxUploadService.getJob("job-456", true);

        assertThat(result.status()).isEqualTo("FAILED");
        assertThat(result.error()).isEqualTo("Job não encontrado no sandbox-orchestrator");
        verify(uploadJobRepository).save(record);
        verify(tokenCostCalculator, never()).calculate(org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
    }
}

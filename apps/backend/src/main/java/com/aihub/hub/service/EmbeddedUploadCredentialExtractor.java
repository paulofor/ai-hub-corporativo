package com.aihub.hub.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

class EmbeddedUploadCredentialExtractor {

    private static final Logger log = LoggerFactory.getLogger(EmbeddedUploadCredentialExtractor.class);

    private static final Set<String> GCP_FILENAMES = Set.of(
        "application_default_credentials.json",
        "application_default_credetials.json"
    );

    private static final Set<String> SSH_FILENAMES = Set.of(
        "id_ed25519",
        "id_ed25519.key",
        "gitlab_id_key"
    );

    private EmbeddedUploadCredentialExtractor() {
    }

    static EmbeddedUploadCredentials extract(byte[] zipBytes) {
        if (zipBytes == null || zipBytes.length == 0) {
            return EmbeddedUploadCredentials.empty();
        }

        UploadedApplicationDefaultCredential gcpCredential = null;
        UploadedGitSshKey sshKey = null;

        try (InputStream input = new ByteArrayInputStream(zipBytes);
             ZipInputStream zip = new ZipInputStream(input, StandardCharsets.UTF_8)) {

            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) {
                    zip.closeEntry();
                    continue;
                }

                String normalized = normalizeEntryName(entry.getName());
                if (gcpCredential == null && matches(normalized, GCP_FILENAMES)) {
                    byte[] data = readAllBytes(zip);
                    if (data.length > 0) {
                        gcpCredential = new UploadedApplicationDefaultCredential(
                            filename(entry.getName()),
                            Base64.getEncoder().encodeToString(data),
                            "application/json"
                        );
                        log.info("Arquivo {} encontrado no ZIP; credencial GCP será encaminhada automaticamente.", entry.getName());
                    }
                } else if (sshKey == null && matches(normalized, SSH_FILENAMES)) {
                    byte[] data = readAllBytes(zip);
                    if (data.length > 0) {
                        sshKey = new UploadedGitSshKey(
                            filename(entry.getName()),
                            Base64.getEncoder().encodeToString(data)
                        );
                        log.info("Arquivo {} encontrado no ZIP; chave SSH será encaminhada automaticamente.", entry.getName());
                    }
                }

                zip.closeEntry();
                if (gcpCredential != null && sshKey != null) {
                    break;
                }
            }
        } catch (IOException ex) {
            log.warn("Falha ao inspecionar ZIP em busca de credenciais embutidas: {}", ex.getMessage());
            return EmbeddedUploadCredentials.empty();
        }

        return new EmbeddedUploadCredentials(gcpCredential, sshKey);
    }

    private static boolean matches(String normalizedEntry, Set<String> candidates) {
        return candidates.stream().anyMatch(normalizedEntry::endsWith);
    }

    private static byte[] readAllBytes(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static String normalizeEntryName(String name) {
        if (name == null) {
            return "";
        }
        return name
            .replace('\\', '/')
            .replaceAll("^/+", "")
            .toLowerCase(Locale.ROOT);
    }

    private static String filename(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        int lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
        if (lastSlash >= 0 && lastSlash < name.length() - 1) {
            return name.substring(lastSlash + 1);
        }
        return name;
    }

    static final class EmbeddedUploadCredentials {
        private final UploadedApplicationDefaultCredential gcpCredential;
        private final UploadedGitSshKey sshKey;

        private EmbeddedUploadCredentials(UploadedApplicationDefaultCredential gcpCredential,
                                          UploadedGitSshKey sshKey) {
            this.gcpCredential = gcpCredential;
            this.sshKey = sshKey;
        }

        static EmbeddedUploadCredentials empty() {
            return new EmbeddedUploadCredentials(null, null);
        }

        UploadedApplicationDefaultCredential gcpCredential() {
            return gcpCredential;
        }

        UploadedGitSshKey sshKey() {
            return sshKey;
        }
    }
}

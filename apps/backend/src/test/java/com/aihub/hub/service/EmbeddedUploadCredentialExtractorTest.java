package com.aihub.hub.service;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

class EmbeddedUploadCredentialExtractorTest {

    @Test
    void shouldExtractEmbeddedGcpCredentialsAndSshKey() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("application_default_credentials.json", json("{\"type\":\"service_account\"}"));
        entries.put(".ssh/id_ed25519.key", "-----BEGIN KEY-----".getBytes(StandardCharsets.UTF_8));
        entries.put("README.md", "# demo".getBytes(StandardCharsets.UTF_8));

        byte[] zipBytes = zip(entries);

        EmbeddedUploadCredentialExtractor.EmbeddedUploadCredentials credentials =
            EmbeddedUploadCredentialExtractor.extract(zipBytes);

        assertNotNull(credentials.gcpCredential());
        assertEquals("application_default_credentials.json", credentials.gcpCredential().filename());
        byte[] decodedGcp = java.util.Base64.getDecoder().decode(credentials.gcpCredential().base64());
        assertArrayEquals(json("{\"type\":\"service_account\"}"), decodedGcp);

        assertNotNull(credentials.sshKey());
        assertEquals("id_ed25519.key", credentials.sshKey().filename());
        byte[] decodedSsh = java.util.Base64.getDecoder().decode(credentials.sshKey().base64());
        assertArrayEquals("-----BEGIN KEY-----".getBytes(StandardCharsets.UTF_8), decodedSsh);
    }

    @Test
    void shouldHandleMissingFilesGracefully() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("src/Main.java", "class Main {}".getBytes(StandardCharsets.UTF_8));

        byte[] zipBytes = zip(entries);
        EmbeddedUploadCredentialExtractor.EmbeddedUploadCredentials credentials =
            EmbeddedUploadCredentialExtractor.extract(zipBytes);

        assertNull(credentials.gcpCredential());
        assertNull(credentials.sshKey());
    }

    @Test
    void shouldSupportCredentialAliases() throws Exception {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("configs/application_default_credetials.json", json("{\"type\":\"service_account\"}"));
        entries.put("git/id_ed25519", "SSH-DATA".getBytes(StandardCharsets.UTF_8));

        byte[] zipBytes = zip(entries);
        EmbeddedUploadCredentialExtractor.EmbeddedUploadCredentials credentials =
            EmbeddedUploadCredentialExtractor.extract(zipBytes);

        assertNotNull(credentials.gcpCredential());
        assertEquals("application_default_credetials.json", credentials.gcpCredential().filename());
        assertNotNull(credentials.sshKey());
        assertEquals("id_ed25519", credentials.sshKey().filename());
    }

    private static byte[] json(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static byte[] zip(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                ZipEntry zipEntry = new ZipEntry(entry.getKey());
                zip.putNextEntry(zipEntry);
                zip.write(entry.getValue());
                zip.closeEntry();
            }
        }
        return output.toByteArray();
    }
}

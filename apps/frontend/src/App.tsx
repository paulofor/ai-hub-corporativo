import { Routes, Route, Navigate } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage';
import ProjectsPage from './pages/ProjectsPage';
import NewProjectWizard from './pages/NewProjectWizard';
import ProjectDetailPage from './pages/ProjectDetailPage';
import PromptsPage from './pages/PromptsPage';
import AuditLogPage from './pages/AuditLogPage';
import ShellLayout from './components/ShellLayout';
import CodexPage from './pages/CodexPage';
import CodexModelsPage from './pages/CodexModelsPage';
import EnvironmentsPage from './pages/EnvironmentsPage';
import UploadJobPage from './pages/UploadJobPage';
import UploadJobDetailPage from './pages/UploadJobDetailPage';
import DockerImagesPage from './pages/DockerImagesPage';

function App() {
  return (
    <ShellLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<NewProjectWizard />} />
        <Route path="/projects/:owner/:repo" element={<ProjectDetailPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="/environments" element={<EnvironmentsPage />} />
        <Route path="/codex" element={<CodexPage />} />
        <Route path="/codex/models" element={<CodexModelsPage />} />
        <Route path="/upload-jobs" element={<UploadJobPage />} />
        <Route path="/upload-jobs/:jobId" element={<UploadJobDetailPage />} />
        <Route path="/docker-images" element={<DockerImagesPage />} />
        <Route path="/audit" element={<AuditLogPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ShellLayout>
  );
}

export default App;

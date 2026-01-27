import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import client from '../api/client';
import { useToasts } from '../components/ToastContext';
import {
  buildJobTitle,
  downloadUploadJobZip,
  getUploadJobStatusClassName,
  parseUploadJob,
  resolveUploadJobTitle,
  UploadJob
} from '../utils/uploadJobs';


type SandboxProfile = 'STANDARD' | 'ECONOMY';

interface CodexModelOption {
  id: string;
  modelName: string;
  displayName?: string;
}

const ownerHeaders = { 'X-Role': 'owner', 'X-User': 'ui-owner' };

export default function UploadJobPage() {
  const { pushToast } = useToasts();
  const [taskDescription, setTaskDescription] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [profile, setProfile] = useState<SandboxProfile>('STANDARD');
  const [model, setModel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problemFiles, setProblemFiles] = useState<File[]>([]);
  const [gcpCredentials, setGcpCredentials] = useState<File | null>(null);
  const [gitPrivateKey, setGitPrivateKey] = useState<File | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<CodexModelOption[]>([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      setJobsLoaded(false);
      const response = await client.get('/upload-jobs');
      const parsed = Array.isArray(response.data)
        ? response.data.map((item: unknown) => parseUploadJob(item))
        : [];
      setJobs(
        parsed.map((job) => ({
          ...job,
          title: resolveUploadJobTitle(
            job.jobId,
            job.title,
            job.taskDescription ? buildJobTitle(job.taskDescription) : undefined
          )
        }))
      );
      setJobsError(null);
    } catch (err) {
      setJobsError((err as Error).message);
    } finally {
      setJobsLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    client
      .get<CodexModelOption[]>('/codex/models')
      .then((response) => {
        setModelOptions(response.data);
        setModel((current) => {
          if (current && response.data.some((item) => item.modelName === current)) {
            return current;
          }
          return '';
        });
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  const handleProblemFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selection = event.target.files ? Array.from(event.target.files) : [];
    setProblemFiles(selection);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedTask = taskDescription.trim();

    if (!file) {
      setError('Envie um arquivo ZIP com os fontes.');
      return;
    }

    if (!trimmedTask) {
      setError('Descreva a tarefa que o modelo deve executar.');
      return;
    }

    setLoading(true);
    setError(null);

    const formData = new FormData();
    formData.append('taskDescription', trimmedTask);
    formData.append('sourceZip', file);
    if (testCommand.trim()) {
      formData.append('testCommand', testCommand.trim());
    }
    if (model.trim()) {
      formData.append('model', model.trim());
    }
    formData.append('profile', profile);
    problemFiles.forEach((problemFile) => {
      formData.append('problemFiles', problemFile);
    });
    if (gcpCredentials) {
      formData.append('applicationDefaultCredentials', gcpCredentials);
    }
    if (gitPrivateKey) {
      formData.append('gitSshPrivateKey', gitPrivateKey);
    }

    try {
      const response = await client.post('/upload-jobs', formData, {
        headers: { 'Content-Type': 'multipart/form-data', ...ownerHeaders }
      });
      const parsed = parseUploadJob(response.data);
      const title = buildJobTitle(trimmedTask);
      const enriched = { ...parsed, title };
      setJobs((current) => [
        enriched,
        ...current.filter((item) => item.jobId !== parsed.jobId)
      ]);
      setTaskDescription('');
      setTestCommand('');
      setFile(null);
      setModel('');
      setProblemFiles([]);
      setGcpCredentials(null);
      setGitPrivateKey(null);
      pushToast('Job criado e enviado para o sandbox.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const refreshJob = async (jobId: string) => {
    try {
      const response = await client.get(`/upload-jobs/${jobId}?refresh=true`);
      if (!response.data) {
        pushToast('Job não encontrado no sandbox.');
        return;
      }
      const parsed = parseUploadJob(response.data);
      const responseJobId = parsed.jobId || jobId;
      setJobs((current) =>
        current.map((job) =>
          job.jobId === jobId
            ? {
                ...job,
                ...parsed,
                jobId: responseJobId,
                title: resolveUploadJobTitle(
                  responseJobId,
                  job.title,
                  parsed.title,
                  parsed.taskDescription ? buildJobTitle(parsed.taskDescription) : undefined
                )
              }
            : job
        )
      );
    } catch (err) {
      console.warn(`Falha ao atualizar job ${jobId}`, err);
      pushToast('Não foi possível atualizar o status do job. Tente novamente.');
    }
  };

  const handleDownloadZip = async (job: UploadJob) => {
    try {
      await downloadUploadJobZip(job);
    } catch (err) {
      console.error('Falha ao preparar ZIP de resultado', err);
      pushToast('Não foi possível preparar o download do ZIP com os fontes gerados.');
    }
  };

  const currencyFormatter = useMemo(() => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }), []);
  const formatCost = (value?: number) => (value != null ? currencyFormatter.format(value) : '—');

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Upload de fontes em ZIP</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Envie o projeto em ZIP, anexe arquivos da solicitação (documentos, imagens, txt, csv, logs etc.) e peça
            recomendações ao modelo.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <form
          onSubmit={handleSubmit}
          className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 space-y-4"
        >
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Arquivo ZIP</label>
            <input
              type="file"
              accept=".zip"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-100 file:px-3 file:py-2 file:text-emerald-700 hover:file:bg-emerald-200 dark:text-slate-200 dark:file:bg-emerald-900/40 dark:file:text-emerald-100"
            />
            {file && <p className="text-xs text-slate-500">Selecionado: {file.name}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Arquivos da solicitação (docs, imagens, logs, ZIP de fontes, etc.)
            </label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Envie documentos, imagens, arquivos de apoio ou um ZIP com fontes de programas; eles ficarão disponíveis
              no sandbox junto com o código.
            </p>
            <input
              type="file"
              multiple
              accept=".txt,.csv,.md,.log,.json,.yaml,.yml,.xml,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.zip,image/*"
              onChange={handleProblemFilesChange}
              className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-100 file:px-3 file:py-2 file:text-emerald-700 hover:file:bg-emerald-200 dark:text-slate-200 dark:file:bg-emerald-900/40 dark:file:text-emerald-100"
            />
            {problemFiles.length > 0 && (
              <ul className="space-y-2 text-xs text-slate-700 dark:text-slate-200">
                {problemFiles.map((problemFile, index) => (
                  <li
                    key={`${problemFile.name}-${index}`}
                    className="flex items-center justify-between rounded-md bg-slate-100 px-2 py-1 dark:bg-slate-800"
                  >
                    <span className="truncate pr-3" title={problemFile.name}>
                      {problemFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setProblemFiles((current) => current.filter((_, idx) => idx !== index))}
                      className="text-[11px] font-semibold text-emerald-700 hover:underline"
                    >
                      Remover
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Credenciais do GCP (application_default_credentials.json)</label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Opcional: envie o arquivo de credenciais para ficarem disponíveis em ~/.config/gcloud/ do sandbox.
              Isso permite que builds Maven acessem bibliotecas do GCP usando essas credenciais.
            </p>
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => setGcpCredentials(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-100 file:px-3 file:py-2 file:text-emerald-700 hover:file:bg-emerald-200 dark:text-slate-200 dark:file:bg-emerald-900/40 dark:file:text-emerald-100"
            />
            {gcpCredentials && (
              <div className="flex items-center justify-between rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <span className="truncate pr-3" title={gcpCredentials.name}>
                  Selecionado: {gcpCredentials.name}
                </span>
                <button
                  type="button"
                  onClick={() => setGcpCredentials(null)}
                  className="text-[11px] font-semibold text-emerald-700 hover:underline"
                >
                  Remover
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Chave privada SSH para GitLab</label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Opcional: envie a chave privada (PEM/OpenSSH) usada pelo GitLab para permitir que o Maven e comandos git no sandbox
              autentiquem via SSH. Ela será salva apenas dentro do workspace temporário em ~/.ssh/.
            </p>
            <input
              type="file"
              accept=".pem,.key,.ppk,.priv,.ssh,.txt,.cfg,.config,.rsa,.ed25519,text/plain"
              onChange={(event) => setGitPrivateKey(event.target.files?.[0] ?? null)}
              className="block w-full text-sm text-slate-700 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-100 file:px-3 file:py-2 file:text-emerald-700 hover:file:bg-emerald-200 dark:text-slate-200 dark:file:bg-emerald-900/40 dark:file:text-emerald-100"
            />
            {gitPrivateKey && (
              <div className="flex items-center justify-between rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                <span className="truncate pr-3" title={gitPrivateKey.name}>
                  Selecionado: {gitPrivateKey.name}
                </span>
                <button
                  type="button"
                  onClick={() => setGitPrivateKey(null)}
                  className="text-[11px] font-semibold text-emerald-700 hover:underline"
                >
                  Remover
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Descrição da tarefa</label>
            <textarea
              value={taskDescription}
              onChange={(event) => setTaskDescription(event.target.value)}
              rows={4}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              placeholder="Ex.: investigar testes que falham no build local"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Comando de teste (opcional)</label>
              <input
                value={testCommand}
                onChange={(event) => setTestCommand(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                placeholder="npm test"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Modelo (opcional)</label>
              <select
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                disabled={modelOptions.length === 0}
              >
                {modelOptions.length === 0 ? (
                  <option value="">Nenhum modelo cadastrado</option>
                ) : (
                  <>
                    <option value="">Selecione um modelo</option>
                    {modelOptions.map((option) => (
                      <option key={option.id} value={option.modelName}>
                        {(option.displayName ?? option.modelName) + ` — ${option.modelName}`}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Perfil</span>
            <div className="flex gap-4 text-sm text-slate-700 dark:text-slate-200">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="upload-profile"
                  checked={profile === 'STANDARD'}
                  onChange={() => setProfile('STANDARD')}
                  className="h-4 w-4"
                />
                Padrão
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="upload-profile"
                  checked={profile === 'ECONOMY'}
                  onChange={() => setProfile('ECONOMY')}
                  className="h-4 w-4"
                />
                Econômico
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Enviando...' : 'Enviar para o sandbox'}
          </button>
        </form>

        <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <h3 className="text-lg font-semibold mb-2">Jobs enviados</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
            Listamos aqui os jobs enviados (armazenados no servidor), para você acompanhar de qualquer lugar.
          </p>
          {jobsError && (
            <p className="mb-3 text-sm text-rose-600">{jobsError}</p>
          )}
          {!jobsLoaded ? (
            <p className="text-sm text-slate-500">Carregando lista de jobs...</p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-slate-500">Nenhum job criado recentemente.</p>
          ) : (
            <div className="space-y-4">
              {jobs.map((job) => {
                const title = resolveUploadJobTitle(job.jobId, job.title, job.taskDescription ? buildJobTitle(job.taskDescription) : undefined);
                const updatedAt = job.updatedAt ?? job.lastSyncedAt;
                const lastUpdatedLabel = updatedAt ? new Date(updatedAt).toLocaleString() : null;
                const costLabel = formatCost(job.cost);
                return (
                  <div key={job.jobId} className="rounded border border-slate-200 dark:border-slate-800 p-3 text-sm">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold">{title}</p>
                          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${getUploadJobStatusClassName(job.status)}`}>
                            {job.status}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500">
                          ID: {job.jobId}
                          {lastUpdatedLabel && <> • Atualizado em {lastUpdatedLabel}</>}
                          <> • Custo estimado: {costLabel}</>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-emerald-700">
                        <button type="button" onClick={() => refreshJob(job.jobId)} className="hover:underline">
                          Atualizar
                        </button>
                        <Link to={`/upload-jobs/${job.jobId}`} className="text-emerald-700 hover:underline dark:text-emerald-300">
                          Ver detalhes
                        </Link>
                      </div>
                    </div>
                    {job.summary && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-600 dark:text-slate-200">Resumo</p>
                        <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{job.summary}</p>
                      </div>
                    )}
                    {job.error && (
                      <p className="mt-2 text-xs text-red-600">Erro: {job.error}</p>
                    )}
                    {job.changedFiles && job.changedFiles.length > 0 && (
                      <div className="mt-2">
                        <p className="text-xs font-semibold text-slate-600 dark:text-slate-200">Arquivos alterados</p>
                        <ul className="mt-1 space-y-1 text-xs text-slate-700 dark:text-slate-300">
                          {job.changedFiles.map((filePath) => (
                            <li key={filePath} className="rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
                              {filePath}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {job.status === 'COMPLETED' && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {job.resultZipBase64 || job.resultZipReady ? (
                          <button
                            type="button"
                            onClick={() => handleDownloadZip(job)}
                            className="inline-flex items-center justify-center rounded-md border border-emerald-600 px-3 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:border-emerald-400 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
                          >
                            Baixar ZIP com fontes atualizados
                          </button>
                        ) : (
                          <p className="text-xs text-slate-500 dark:text-slate-400">ZIP ainda está sendo gerado.</p>
                        )}
                      </div>
                    )}
                    {job.patch && job.patch.trim() && (
                      <details className="mt-3">
                        <summary className="cursor-pointer text-xs font-semibold text-emerald-700">Ver patch</summary>
                        <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900/90 p-3 text-[11px] text-emerald-100">
                          {job.patch}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

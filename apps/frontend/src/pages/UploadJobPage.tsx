import { ChangeEvent, FormEvent, useEffect, useState } from 'react';
import client from '../api/client';
import { useToasts } from '../components/ToastContext';

type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
type SandboxProfile = 'STANDARD' | 'ECONOMY';

interface UploadJob {
  jobId: string;
  status: JobStatus;
  summary?: string;
  error?: string;
  changedFiles?: string[];
  patch?: string;
}

interface CodexModelOption {
  id: string;
  modelName: string;
  displayName?: string;
}

const ownerHeaders = { 'X-Role': 'owner', 'X-User': 'ui-owner' };

const parseJob = (payload: unknown): UploadJob => {
  const data = (payload ?? {}) as Record<string, unknown>;
  const changedFiles = Array.isArray(data.changedFiles)
    ? (data.changedFiles as unknown[])
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : undefined;

  const status = typeof data.status === 'string' ? (data.status.toUpperCase() as JobStatus) : 'PENDING';

  return {
    jobId: typeof data.jobId === 'string' ? data.jobId : '',
    status,
    summary: typeof data.summary === 'string' ? data.summary : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
    changedFiles,
    patch: typeof data.patch === 'string' ? data.patch : undefined
  };
};

export default function UploadJobPage() {
  const { pushToast } = useToasts();
  const [taskDescription, setTaskDescription] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [profile, setProfile] = useState<SandboxProfile>('STANDARD');
  const [model, setModel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [problemFiles, setProblemFiles] = useState<File[]>([]);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<CodexModelOption[]>([]);

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

    try {
      const response = await client.post('/upload-jobs', formData, {
        headers: { 'Content-Type': 'multipart/form-data', ...ownerHeaders }
      });
      const parsed = parseJob(response.data);
      setJobs((current) => [parsed, ...current.filter((item) => item.jobId !== parsed.jobId)]);
      setTaskDescription('');
      setTestCommand('');
      setFile(null);
      setModel('');
      setProblemFiles([]);
      pushToast('Job criado e enviado para o sandbox.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const refreshJob = async (jobId: string) => {
    const response = await client.get(`/upload-jobs/${jobId}`);
    const parsed = parseJob(response.data);
    setJobs((current) => current.map((job) => (job.jobId === jobId ? parsed : job)));
  };

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Upload de fontes em ZIP</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Envie o projeto em ZIP, anexe arquivos (txt, csv etc.) descrevendo o problema e peça recomendações ao modelo.
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
            <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Arquivos do problema (txt, csv, logs, etc.)</label>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Envie arquivos que descrevam o erro encontrado; eles ficarão disponíveis no sandbox junto com o código.
            </p>
            <input
              type="file"
              multiple
              accept=".txt,.csv,.md,.log,.json,.yaml,.yml,.xml"
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
          <h3 className="text-lg font-semibold mb-3">Jobs enviados</h3>
          {jobs.length === 0 && (
            <p className="text-sm text-slate-500">Nenhum job criado nesta sessão.</p>
          )}
          <div className="space-y-4">
            {jobs.map((job) => (
              <div key={job.jobId} className="rounded border border-slate-200 dark:border-slate-800 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{job.jobId}</p>
                    <p className="text-xs text-slate-500">Status: {job.status}</p>
                  </div>
                  <button
                    onClick={() => refreshJob(job.jobId)}
                    className="text-xs text-emerald-700 hover:underline disabled:opacity-50"
                  >
                    Atualizar
                  </button>
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
                {job.patch && job.patch.trim() && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-emerald-700">Ver patch</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-slate-900/90 p-3 text-[11px] text-emerald-100">
                      {job.patch}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

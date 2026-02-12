import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
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

export default function UploadJobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { pushToast } = useToasts();
  const [job, setJob] = useState<UploadJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadJob = useCallback(async () => {
    if (!jobId) {
      return;
    }
    setLoading(true);
    setError(null);
    const applyJobPayload = (payload: unknown) => {
      const parsed = parseUploadJob(payload);
      setJob((current) => {
        const resolvedJobId = parsed.jobId || jobId;
        const nextJob: UploadJob = {
          ...(current ?? { jobId: resolvedJobId, status: parsed.status }),
          ...parsed,
          jobId: resolvedJobId,
          title: resolveUploadJobTitle(
            resolvedJobId,
            current?.title,
            parsed.title,
            parsed.taskDescription ? buildJobTitle(parsed.taskDescription) : undefined
          )
        };
        return nextJob;
      });
    };
    try {
      const response = await client.get(`/upload-jobs/${jobId}?refresh=true`);
      if (!response.data) {
        setError('Job não encontrado no sandbox.');
        setJob(null);
        return;
      }
      applyJobPayload(response.data);
    } catch (err) {
      const refreshError = (err as Error).message;
      try {
        const fallbackResponse = await client.get(`/upload-jobs/${jobId}`);
        if (!fallbackResponse.data) {
          setError(refreshError);
          return;
        }
        applyJobPayload(fallbackResponse.data);
        setError(
          `${refreshError} (exibindo último status salvo; use “Baixar ZIP” se o resultado já estiver pronto)`
        );
      } catch {
        setError(refreshError);
      }
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (!jobId) {
      setError('Job não informado.');
      setLoading(false);
      return;
    }
    loadJob();
  }, [jobId, loadJob]);

  const handleDownloadZip = async () => {
    if (!job) {
      return;
    }
    try {
      await downloadUploadJobZip(job);
    } catch (err) {
      console.error('Falha ao preparar ZIP de resultado', err);
      pushToast('Não foi possível preparar o download do ZIP com os fontes gerados.');
    }
  };

  const handleCopyDescription = async () => {
    if (!job?.taskDescription) {
      pushToast('Nenhuma descrição disponível para copiar.');
      return;
    }
    try {
      await navigator.clipboard.writeText(job.taskDescription);
      pushToast('Descrição copiada.');
    } catch (err) {
      console.error('Falha ao copiar descrição do job', err);
      pushToast('Não foi possível copiar a descrição.');
    }
  };

  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD' }),
    []
  );

  const formatNumber = (value?: number) => (value != null ? value.toLocaleString('pt-BR') : '—');
  const formatCost = (value?: number) => (value != null ? currencyFormatter.format(value) : '—');

  const displayTitle = resolveUploadJobTitle(
    jobId ?? '',
    job?.title,
    job?.taskDescription ? buildJobTitle(job.taskDescription) : undefined
  );
  const updatedAt = job?.updatedAt ?? job?.lastSyncedAt;
  const lastUpdatedLabel = updatedAt ? new Date(updatedAt).toLocaleString() : null;
  const zipReady = Boolean(job?.resultZipBase64 || job?.resultZipReady);

  const jobCostLabel = formatCost(job?.cost);
  const showCostBadge = jobCostLabel !== '—' && Boolean(job);

  const zipStatusMessage = (() => {
    if (!job) {
      return 'Carregue o status do job para verificar o ZIP.';
    }
    if (job.status !== 'COMPLETED') {
      return 'O ZIP será liberado após a conclusão do job.';
    }
    if (job.resultZipBase64) {
      return job.resultZipFilename
        ? `ZIP pronto para download (${job.resultZipFilename}).`
        : 'ZIP pronto para download.';
    }
    if (job.resultZipReady) {
      return job.resultZipFilename
        ? `ZIP pronto para download (${job.resultZipFilename}). Use o botão “Baixar ZIP”.`
        : 'ZIP pronto para download. Use o botão “Baixar ZIP”.';
    }
    return 'O sandbox ainda está preparando o arquivo ZIP final.';
  })();

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3">
        <Link to="/upload-jobs" className="text-xs font-semibold text-emerald-700 hover:underline">
          &larr; Voltar para a lista de jobs
        </Link>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{displayTitle}</h2>
            <p className="text-sm text-slate-500">
              ID: {jobId ?? '—'}
              {lastUpdatedLabel && <> • Última sincronização em {lastUpdatedLabel}</>}
              {showCostBadge && <> • Custo estimado: {jobCostLabel}</>}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {job && (
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${getUploadJobStatusClassName(job.status)}`}>
                {job.status}
              </span>
            )}
            <button
              type="button"
              onClick={loadJob}
              disabled={!jobId || loading}
              className="rounded-md border border-slate-300 px-3 py-1 font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Atualizando...' : 'Atualizar status'}
            </button>
            <button
              type="button"
              onClick={handleDownloadZip}
              disabled={!zipReady}
              className="rounded-md border border-emerald-600 px-3 py-1 font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-400 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
            >
              Baixar ZIP
            </button>
          </div>
        </div>
        {loading && !job && <p className="text-sm text-slate-500">Carregando dados do job...</p>}
        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
            {error}
          </div>
        )}
      </div>

      {job ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">Descrição da tarefa</h3>
              <button
                type="button"
                onClick={handleCopyDescription}
                disabled={!job.taskDescription}
                className="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Copiar descrição
              </button>
            </div>
            {job.taskDescription ? (
              <pre className="mt-3 whitespace-pre-wrap rounded-md bg-slate-100 p-4 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {job.taskDescription}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nenhuma descrição foi enviada para este job.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h3 className="text-lg font-semibold">Resumo do processamento</h3>
            {job.summary ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">{job.summary}</p>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nenhum resumo foi retornado pelo sandbox.</p>
            )}
            {job.error && <p className="mt-3 text-sm text-rose-600">Erro reportado: {job.error}</p>}
            {job.pullRequestUrl && (
              <p className="mt-3 text-sm text-emerald-700">
                <a href={job.pullRequestUrl} target="_blank" rel="noreferrer" className="underline">
                  Abrir pull request sugerido
                </a>
              </p>
            )}
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Prompt tokens</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{formatNumber(job.promptTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Prompt em cache</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{formatNumber(job.cachedPromptTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Completion tokens</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{formatNumber(job.completionTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Total tokens</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{formatNumber(job.totalTokens)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-500">Custo estimado</dt>
                <dd className="text-sm font-semibold text-slate-800 dark:text-slate-100">{formatCost(job.cost)}</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h3 className="text-lg font-semibold">Arquivos alterados</h3>
            {job.changedFiles && job.changedFiles.length > 0 ? (
              <ul className="mt-3 space-y-2 text-sm text-slate-700 dark:text-slate-200">
                {job.changedFiles.map((filePath) => (
                  <li key={filePath} className="rounded-md bg-slate-100 px-3 py-1 dark:bg-slate-800">
                    {filePath}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nenhum arquivo foi listado como alterado.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h3 className="text-lg font-semibold">Patch gerado</h3>
            {job.patch && job.patch.trim() ? (
              <pre className="mt-3 max-h-[500px] overflow-auto rounded-md bg-slate-900/90 p-4 text-xs text-emerald-100">
                {job.patch}
              </pre>
            ) : (
              <p className="mt-2 text-sm text-slate-500">Nenhum patch disponível para este job.</p>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white/70 p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
            <h3 className="text-lg font-semibold">ZIP final</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">{zipStatusMessage}</p>
            {job.resultZipFilename && (
              <p className="mt-2 text-xs text-slate-500">Nome sugerido: {job.resultZipFilename}</p>
            )}
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <button
                type="button"
                onClick={handleDownloadZip}
                disabled={!zipReady}
                className="rounded-md border border-emerald-600 px-3 py-1 font-semibold text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-400 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
              >
                Baixar ZIP
              </button>
              <button
                type="button"
                onClick={loadJob}
                disabled={loading}
                className="rounded-md border border-slate-300 px-3 py-1 font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Recarregar status
              </button>
            </div>
          </div>
        </div>
      ) : (
        !loading && !error && (
          <p className="text-sm text-slate-500">Nenhum dado disponível para este job.</p>
        )
      )}
    </section>
  );
}

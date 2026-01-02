import { useState } from 'react';
import client from '../api/client';
import ConfirmButton from '../components/ConfirmButton';
import { useToasts } from '../components/ToastContext';
import { useNavigate } from 'react-router-dom';

const ownerHeaders = { 'X-Role': 'owner', 'X-User': 'ui-owner' };

export default function NewProjectWizard() {
  const navigate = useNavigate();
  const { pushToast } = useToasts();
  const [step, setStep] = useState(1);
  const totalSteps = 3;
  const [form, setForm] = useState({
    org: '',
    name: '',
    isPrivate: true,
    useTemplate: false,
    templateOwner: '',
    templateRepo: ''
  });

  const next = () => setStep((s) => Math.min(totalSteps, s + 1));
  const prev = () => setStep((s) => Math.max(1, s - 1));

  const canAdvance = () => {
    if (step === 1) return form.org !== '' && form.name !== '';
    if (step === 2) {
      if (!form.useTemplate) return true;
      return form.templateOwner !== '' && form.templateRepo !== '';
    }
    return true;
  };

  const createProject = async () => {
    const payload = {
      org: form.org,
      name: form.name,
      isPrivate: form.isPrivate,
      useTemplate: form.useTemplate,
      templateOwner: form.useTemplate ? form.templateOwner : undefined,
      templateRepo: form.useTemplate ? form.templateRepo : undefined
    };
    const response = await client.post('/projects', payload, { headers: ownerHeaders });
    pushToast('Projeto criado com sucesso!');
    const [owner, repo] = response.data.repo.split('/');
    navigate(`/projects/${owner}/${repo}`);
  };

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Novo projeto</h2>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Siga as etapas para provisionar um repositório GitHub vazio ou a partir de um template existente.
          </p>
        </div>
        <p className="text-sm font-semibold text-slate-500">Passo {step} de {totalSteps}</p>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 p-6 space-y-6">
        {step === 1 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">1. Organização e nome do repositório</h3>
            <div>
              <label className="block text-sm font-medium">Organização</label>
              <input
                value={form.org}
                onChange={(event) => setForm((prev) => ({ ...prev, org: event.target.value }))}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:border-slate-700"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Nome do repositório</label>
              <input
                value={form.name}
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:border-slate-700"
                required
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">2. Opções</h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.isPrivate}
                onChange={(event) => setForm((prev) => ({ ...prev, isPrivate: event.target.checked }))}
              />
              Repositório privado
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.useTemplate}
                onChange={(event) => setForm((prev) => ({ ...prev, useTemplate: event.target.checked }))}
              />
              <span>Usar repositório template existente</span>
            </label>
            {form.useTemplate && (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div>
                  <label className="block text-sm font-medium">Dono do template</label>
                  <input
                    value={form.templateOwner}
                    onChange={(event) => setForm((prev) => ({ ...prev, templateOwner: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium">Nome do template</label>
                  <input
                    value={form.templateRepo}
                    onChange={(event) => setForm((prev) => ({ ...prev, templateRepo: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:bg-slate-900 dark:border-slate-700"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold">3. Revisão</h3>
            <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
              <div>
                <dt className="font-medium text-slate-500">Organização</dt>
                <dd className="font-semibold">{form.org}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Repositório</dt>
                <dd className="font-semibold">{form.name}</dd>
              </div>
              <div>
                <dt className="font-medium text-slate-500">Privado</dt>
                <dd className="font-semibold">{form.isPrivate ? 'Sim' : 'Não'}</dd>
              </div>
              <div className="md:col-span-2">
                <dt className="font-medium text-slate-500">Template</dt>
                <dd className="font-semibold">
                  {form.useTemplate
                    ? `${form.templateOwner}/${form.templateRepo}`
                    : 'Criar repositório vazio'}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-500">
              Ao confirmar, o AI Hub Corp criará o repositório na organização informada, configurará o webhook e registrará a ação no audit log.
            </p>
            <ConfirmButton
              onConfirm={createProject}
              label="Preparar"
              confirmLabel="Confirmar criação do repositório"
              disabled={!canAdvance()}
            />
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 pt-4">
          <button
            type="button"
            onClick={prev}
            disabled={step === 1}
            className="text-sm text-slate-500 disabled:opacity-40"
          >
            Voltar
          </button>
          {step < totalSteps && (
            <button
              type="button"
              onClick={next}
              disabled={!canAdvance()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow disabled:opacity-40"
            >
              Próximo
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

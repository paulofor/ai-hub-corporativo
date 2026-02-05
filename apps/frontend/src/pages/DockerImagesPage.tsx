const downloadUrl = '/downloads/ai-hub-images.tar';

const steps = [
  {
    title: '1) Baixe o arquivo compactado com as imagens',
    description:
      'Use o botão abaixo para baixar o pacote compactado com as imagens do backend, frontend e sandbox.'
  },
  {
    title: '2) Carregue as imagens no Docker',
    description: 'No terminal da sua máquina, rode o comando:'
  },
  {
    title: '3) Suba os serviços com Docker Compose',
    description: 'Com o .env ajustado, rode:'
  },
  {
    title: '4) Acesse a aplicação',
    description: 'Frontend em http://localhost:8082 e API em http://localhost:8081.'
  }
];

export default function DockerImagesPage() {
  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Download das imagens Docker</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Use esta opção para baixar o pacote de imagens Docker e executar o AI Hub
          completamente na sua máquina.
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 p-5 shadow-sm space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              Pacote completo (.tar)
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Inclui backend, frontend e sandbox-orchestrator.
            </p>
          </div>
          <a
            href={downloadUrl}
            download
            className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
          >
            Baixar imagens
          </a>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Caso o download não inicie, verifique se o arquivo
          <span className="font-semibold"> ai-hub-images.tar</span> está publicado em
          <span className="font-mono">/usr/share/nginx/html/downloads</span> e acessível em
          <span className="font-mono">{downloadUrl}</span>.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {steps.map((step) => (
          <div
            key={step.title}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white/70 dark:bg-slate-900/60 p-4"
          >
            <h4 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {step.title}
            </h4>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{step.description}</p>
            {step.title.startsWith('2') && (
              <pre className="mt-3 rounded-lg bg-slate-900/90 text-slate-100 p-3 text-xs overflow-x-auto">
                docker load -i ai-hub-images.tar
              </pre>
            )}
            {step.title.startsWith('3') && (
              <pre className="mt-3 rounded-lg bg-slate-900/90 text-slate-100 p-3 text-xs overflow-x-auto">
                docker compose up -d
              </pre>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

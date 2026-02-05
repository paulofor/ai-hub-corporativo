const downloadUrl = '/downloads/ai-hub-images.tar';
const checksumUrl = `${downloadUrl}.sha256`;
const composeUrl = '/downloads/docker-compose.yml';

const steps = [
  {
    title: '1) Baixe os arquivos necessários',
    description:
      'Baixe o pacote compactado com as imagens, o checksum e o arquivo docker-compose.yml.'
  },
  {
    title: '2) Carregue as imagens no Docker',
    description: 'No terminal da sua máquina, rode o comando:'
  },
  {
    title: '3) Suba os serviços com Docker Compose',
    description:
      'Crie uma pasta, copie o docker-compose.yml para ela e ajuste o .env antes de subir.'
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
              Inclui backend, frontend e sandbox-orchestrator. O arquivo é regenerado a cada deploy
              para garantir que corresponda às imagens publicadas no GHCR.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <a
              href={downloadUrl}
              download
              className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Baixar imagens
            </a>
            <a
              href={checksumUrl}
              download
              className="inline-flex items-center justify-center rounded-md border border-emerald-200 px-4 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
            >
              SHA-256
            </a>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
              docker-compose.yml
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              O Docker Compose precisa desse arquivo para subir os serviços. Baixe e execute o
              comando no mesmo diretório.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <a
              href={composeUrl}
              download
              className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
            >
              Baixar docker-compose.yml
            </a>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 space-y-1">
          <span className="block">
            Caso o download não inicie, verifique se o arquivo
            <span className="font-semibold"> ai-hub-images.tar</span> está publicado em
            <span className="font-mono">/usr/share/nginx/html/downloads</span> e acessível em
            <span className="font-mono">{downloadUrl}</span>.
          </span>
          <span className="block">
            Depois de baixar o <span className="font-mono">docker-compose.yml</span>, crie uma
            pasta (ex.: <span className="font-mono">ai-hub-corp</span>), copie o arquivo para lá e
            adicione o <span className="font-mono">.env</span>. Exemplo:
            <code className="mx-1 block rounded bg-slate-900/80 px-2 py-1 text-[10px] text-slate-100">
              mkdir ai-hub-corp &amp;&amp; cd ai-hub-corp
              <br />
              cp ~/Downloads/docker-compose.yml .
              <br />
              cp ~/Downloads/.env .
            </code>
          </span>
          <span className="block">
            Se o <code className="mx-1 rounded bg-slate-900/80 px-1 py-0.5 text-[10px] text-slate-100">
              docker compose up -d
            </code>
            retornar <span className="font-semibold">no configuration file provided</span>,
            significa que o comando foi executado fora da pasta com o
            <span className="font-mono"> docker-compose.yml</span>.
          </span>
          <span className="block">
            Para validar a integridade, baixe também o checksum em
            <span className="font-mono"> {checksumUrl}</span> e execute
            <code className="mx-1 rounded bg-slate-900/80 px-1 py-0.5 text-[10px] text-slate-100">
              sha256sum -c ai-hub-images.tar.sha256
            </code>
            antes de carregar as imagens.
          </span>
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

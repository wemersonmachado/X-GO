# Docker local no Windows

## Localização definida

- Dados do Docker Desktop / WSL: `E:\Docker\wsl`
- Dados de contêineres Windows: `E:\Docker\windows-containers`
- Repositório: `D:\PROJETOS\Agentes\Agentes\DeskComm`

O Docker Desktop usa o backend WSL 2. O executável é instalado pelo pacote
oficial `Docker.DockerDesktop`; o local exato do programa depende do modo de
instalação escolhido pelo instalador, mas os dados pesados devem permanecer em
`E:\Docker`.

## Primeira ativação

1. Reinicie o Windows depois de habilitar WSL 2.
2. Abra Docker Desktop e confirme o backend **WSL 2**.
3. Em **Settings > Resources > Advanced**, confirme que a imagem de disco está
   em `E:\Docker\wsl`.
4. Em **Settings > Resources > WSL Integration**, ative a distribuição
   **Ubuntu** e aplique a configuração. Sem isso, `pnpm test:db` encontra o
   Docker no Windows, mas não dentro do `bash` usado pelo harness.
5. No PowerShell, valide:

```powershell
wsl --status
docker version
docker run --rm hello-world
wsl -d Ubuntu -- bash -lc 'docker version'
```

O Docker Desktop não oferece seletor de idioma para PT-BR. A interface pode
continuar em inglês mesmo com Windows e terminal em português; isso não altera
o funcionamento do daemon nem dos testes.

## Validação deste repositório

Com Docker Desktop em execução, na raiz do repositório:

```powershell
pnpm test:db
pnpm test:e2e
docker build --progress=plain -t deskcommcrm:local .
```

`pnpm test:db` valida schema, RLS e invariantes em Postgres efêmero.
`pnpm test:e2e` valida a experiência do usuário. O build Docker reproduz a
imagem do aplicativo publicada pelo CI.

Se o `node_modules` do NTFS estiver com `EPERM`/ACL corrompida, não repita a
instalação no diretório do projeto. Use um volume Linux e o heap necessário para
o TypeScript deste repositório:

```powershell
docker volume create deskcomm-node-deps-validation
docker run --rm --memory 7g `
  -e NODE_OPTIONS=--max-old-space-size=6144 `
  --mount "type=bind,src=$PWD,dst=/workspace" `
  --mount "type=volume,src=deskcomm-node-deps-validation,dst=/workspace/node_modules" `
  -w /workspace node:22-bookworm `
  bash -lc 'corepack enable && pnpm install --frozen-lockfile && pnpm gov:verify'
```

Nas execuções seguintes, preserve o volume: o `pnpm` reutiliza os pacotes e não
repete o download. O heap de 6 GB evita o aborto do `tsc` no limite padrão de
2 GB; o limite do contêiner continua em 7 GB para não consumir toda a máquina.

## Regra operacional

Não promova uma imagem ou faça redeploy para corrigir um pipeline vermelho sem
primeiro reproduzir e identificar o erro. Após cada validação, pare apenas os
containers de teste criados para a tarefa; não execute limpezas globais de
imagens, volumes ou dados de outros projetos.

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
4. No PowerShell, valide:

```powershell
wsl --status
docker version
docker run --rm hello-world
```

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

## Regra operacional

Não promova uma imagem ou faça redeploy para corrigir um pipeline vermelho sem
primeiro reproduzir e identificar o erro. Após cada validação, pare apenas os
containers de teste criados para a tarefa; não execute limpezas globais de
imagens, volumes ou dados de outros projetos.

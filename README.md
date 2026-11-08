# Centro de Estudos e Explicações Virtus

Base independente da **Plataforma de Ensino V - Online**. Este repositório não partilha código publicado, variáveis de ambiente, base de dados nem armazenamento com a Sala de Aula Virtus.

## Estado actual

O Passo 1 está preparado:

- esquema Supabase isolado (`profiles` e `course_state`);
- rota segura para criar matrículas em `api/admin/provision.js`;
- geração automática de `nome.apelido`, e-mail virtual e palavra-passe inicial `123456`;
- perfis `Aluno`, `Professor` e `Professor Admin`;
- troca obrigatória de palavra-passe no primeiro acesso;
- painel de matrícula em `/admin/provisioning`.

## Variáveis necessárias no novo Vercel

Configure apenas no futuro projecto Vercel `centro-estudosvirtus`:

```text
SUPABASE_URL=https://uqpwtltdamdqxquwqioh.supabase.co
SUPABASE_ANON_KEY=<anon key do novo projecto>
SUPABASE_SERVICE_ROLE_KEY=<service role/secret key do novo projecto>
CENTRO_BOOTSTRAP_TOKEN=<segredo longo e exclusivo>
```

A primeira conta deve ser criada em `/admin/provisioning?setup=1` com a chave `CENTRO_BOOTSTRAP_TOKEN`. Em seguida, os Professores Admin criam as restantes contas pelo painel normal.

## Limites do passo actual

O Virtus Detector, a Preparação para Provas e Exames e o Pátio serão adaptados em etapas posteriores. A Sala de Aula Virtus continua no seu próprio repositório, Vercel e Supabase.


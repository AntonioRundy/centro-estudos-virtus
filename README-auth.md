# Acesso e armazenamento — Sala Virtus

## Autenticação e dados académicos

A plataforma usa Supabase Auth para iniciar sessão, exigir a mudança da senha temporária dos alunos e encaminhar operações académicas à API protegida do Vercel. As contas são fechadas: só os perfis provisionados entram na plataforma.

Os perfis ficam na tabela privada `profiles`. O estado académico — questionários, respostas, pautas, tarefas, presença, participação e materiais — fica em `course_state` no Supabase. A API do Vercel valida cada sessão e mantém controlo de versões para detectar alterações concorrentes feitas pelos docentes.

## Ficheiros da turma

Materiais de aula e entregas de tarefas são enviados directamente do navegador para o Supabase Storage, por uma ligação de envio assinada e de uso limitado. A API do Vercel cria automaticamente o bucket privado `sala-virtus-private` no primeiro envio. O bucket não é público; para abrir ou descarregar um ficheiro, a API confirma a sessão e a autorização e emite uma ligação de leitura temporária. O limite actual é de 50 MB por ficheiro.

A chave de serviço (`SUPABASE_SERVICE_ROLE_KEY` ou `SUPABASE_SECRET_KEY`) é usada exclusivamente nas funções do servidor; nunca a inclua no HTML, num ficheiro `.env` versionado ou no repositório. O Vercel precisa de ter a URL e a chave de servidor configuradas nas variáveis de ambiente de produção.

## Recuperação de palavra-passe

No ecrã de acesso, **Não consigo entrar** gera uma palavra-passe temporária aleatória, obriga a sua substituição no acesso seguinte e envia a credencial temporária exclusivamente ao endereço administrativo configurado. Para activar o envio, configure no Vercel, apenas em **Production**:

- `RESEND_API_KEY`: chave da API Resend;
- `VIRTUS_MAIL_FROM`: remetente verificado no Resend, por exemplo `Sala Virtus <acesso@dominio-verificado>`;
- `VIRTUS_RECOVERY_EMAIL`: endereço que recebe os pedidos (por predefinição, `rundyelidio@gmail.com`).

Sem essas três variáveis, o sistema não repõe silenciosamente a palavra-passe: devolve um erro claro e mantém o coordenador informado de que o e-mail ainda não está configurado. A chave de e-mail nunca deve ser exposta no navegador ou no repositório.

Ficheiros carregados antes desta actualização não foram automaticamente transferidos. Na página **Aulas**, o professor pode usar **Partilhar** para publicar um material antigo que ainda esteja neste navegador, ou seleccionar novamente o ficheiro. Para uma entrega antiga sem anexo, o aluno pode abrir a tarefa e reenviar o ficheiro; a nota existente é preservada.

## Contas e alterações futuras

A lista de alunos é sincronizada com os perfis registados no Supabase. O cadastro académico pela interface não cria uma conta de autenticação. Novos acessos são criados no painel protegido `/admin/provisioning`, disponível apenas a perfis com a flag `is_superadmin`. O painel cria o utilizador no Supabase Auth e o perfil privado de forma atómica, devolvendo a palavra-passe temporária apenas no fim da operação.

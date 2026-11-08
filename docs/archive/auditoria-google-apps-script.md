# Auditoria do Virtus-Detector

## Escopo

Revisei o código Apps Script enviado e comparei o contrato de dados com a página atual em `outputs/index.html`. O anexo contém o backend, mas não inclui uma URL de Web App implantada nem os ficheiros `index.html`/`admin.html` mencionados nos comentários do próprio script.

## Bloqueios à integração

1. **Falta o endpoint:** sem o URL terminado em `/exec`, a página não tem para onde enviar respostas ou fotografias. O Apps Script só recebe chamadas depois de ser implantado como Web App e configurado com uma identidade e permissões de execução. [Documentação de Web Apps do Apps Script](https://developers.google.com/apps-script/guides/web)
2. **Destino de email fixo:** o script envia relatórios, respostas e fotografias para um endereço definido no código. É necessário confirmar o destinatário docente antes de encaminhar dados dos alunos.
3. **A prova não está sincronizada:** o site atual cria o `Questionário 1` localmente; o `doGet` do script procura a prova numa folha Google. O ID local `quiz-sp-01` não é automaticamente criado na folha `Provas`.
4. **Identidade incompleta:** a lista atual não tem email ou número de aluno e o seletor de perfil não autentica ninguém. Assim, o backend não consegue confirmar de forma fiável que a resposta pertence à pessoa indicada.

## Problemas de segurança e fiabilidade no backend

- A chave de administração está embutida no código. Uma chave entregue ao navegador ou partilhada no código não deve ser tratada como segredo; deve ser rodada e guardada no `ScriptProperties`.
- `doPost` não valida a estrutura, o tamanho ou os tipos dos dados de submissão e não limita o número/tamanho das fotografias. Uma chamada direta pode gravar dados arbitrários e acionar PDFs e emails.
- A verificação de submissão única é feita pelo email enviado pelo cliente; não comprova a identidade e a consulta seguida de `appendRow` não é atómica em acessos simultâneos.
- Campos fornecidos pelo aluno são inseridos diretamente no corpo HTML do email. Devem ser escapados antes de gerar HTML. Os valores gravados nas Sheets também precisam de proteção contra fórmulas iniciadas por `=`.
- O relatório transforma automaticamente o índice em “APROVADO” ou “REPROVADO”. Recomendo que o índice seja apenas um sinal para revisão do professor, sem decisão automática sobre a avaliação.
- O script cria documentos, folhas, PDFs e envia email com as permissões da conta que o implantou. As permissões de acesso e a identidade de execução precisam ser revistas na implantação. [Definições de acesso e execução](https://developers.google.com/apps-script/manifest/web-app-api-executable)

## Limites dos controlos no navegador

- `visibilitychange` pode detetar quando a página fica oculta, e `blur`/`focus` podem sinalizar perda de foco. Esses eventos não provam fraude; também ocorrem por notificações, diálogos do sistema ou outras ações legítimas. [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- A página pode bloquear alguns menus, seleção e atalhos recebidos pelo navegador, mas não consegue garantir o bloqueio de capturas feitas pelo sistema operativo, extensões, outro dispositivo ou ferramentas externas. Portanto, não é possível garantir supervisão “100%”.
- Fotografias pela webcam dependem de permissão explícita do aluno e de um contexto seguro. O navegador mostra indicadores de utilização da câmara; a página não pode conceder esse acesso silenciosamente. [getUserMedia e permissões](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia.)

## Próximo passo necessário

Para ligar a página sem enviar dados para um destino incorreto, preciso do URL `/exec` da implantação e da confirmação do email docente que deve receber os relatórios. Também será necessário definir como identificar cada aluno (email institucional, número ou autenticação própria). Até isso estar configurado, qualquer fotografia ou resposta enviada para o backend pode ir para o destinatário fixo atualmente escrito no script.

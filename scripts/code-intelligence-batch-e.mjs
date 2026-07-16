import { runLanguageBatch } from './code-intelligence-language-batch.mjs';

await runLanguageBatch({
  batch: 'E',
  languages: ['php', 'ruby'],
  repositoryScopes: {
    cirepo_php_laravel_framework: 'src/Illuminate/Routing',
    cirepo_php_slimphp_slim: 'Slim',
    cirepo_php_symfony_symfony: 'src/Symfony/Component/Routing',
    cirepo_ruby_rails_rails: 'actionpack/lib/action_dispatch/routing',
    cirepo_ruby_ruby_rake: 'lib/rake',
    cirepo_ruby_sinatra_sinatra: 'lib/sinatra'
  },
  claimReason: 'Batch E measures reviewed PHP and Ruby truth. It does not change the public engine or claim competitor parity.'
});

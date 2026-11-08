# Test Scrapling sur loadix.fun

Test isolé, hors de Lumière : est-ce que [Scrapling](https://github.com/D4Vinci/Scrapling) passe la
vérification anti-robot de loadix.fun et arrive jusqu'aux liens 1fichier d'un film ?

## Installation (une fois)

Dans PowerShell, depuis la racine du dépôt :

```powershell
cd tools\scrapling-test
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install "scrapling[fetchers]"
.venv\Scripts\scrapling install
```

La dernière commande télécharge le navigateur Chromium (quelques centaines de Mo). Python 3.12 est
conseillé : avec une version plus récente, certaines dépendances peuvent ne pas encore s'installer.

## Lancer le test

```powershell
.venv\Scripts\python test_loadix.py
```

Options utiles :

| Option                                | Effet                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| `--titre "Oppenheimer"`               | Autre titre (défaut : Dune)                                  |
| `--type series`                       | Chercher une série plutôt qu'un film                         |
| `--rang 2`                            | Ouvrir le 2ᵉ résultat de la recherche                        |
| `--page https://loadix.fun/media/123` | Ouvrir directement une page de titre, sans recherche         |
| `--visible`                           | Montrer la fenêtre du navigateur (pour voir la vérification) |
| `--chrome`                            | Utiliser le Chrome installé sur le PC au lieu de Chromium    |
| `--delai 120`                         | Attendre jusqu'à 120 s par page (défaut : 60)                |

## Blocage par la box

Le DNS de la box répond `127.0.0.1` pour loadix.fun : le navigateur se connecterait au PC lui-même
(`ERR_CONNECTION_REFUSED`). Le script demande donc la vraie adresse au DNS chiffré de Cloudflare et
l'impose à Chromium (section « Réseau » de la sortie).

## Lire le résultat

- **RÉUSSITE** : les liens 1fichier sont affichés. Scrapling suffit, on peut envisager de
  l'intégrer.
- **ÉCHEC sur la recherche** ou **Traces de vérification encore présentes** : la vérification
  n'est pas passée. Réessayez avec `--visible`, puis `--visible --chrome`.
- **Aucun lien 1fichier sur la page du titre** : la vérification est passée, mais les liens sont
  ailleurs (derrière un bouton, un site de redirection…). Le script liste les sites et boutons
  trouvés.

Chaque page visitée est enregistrée dans `sortie/` (`1-recherche.html`, `2-titre.html`). En cas
d'échec, envoyez la sortie de la console et ces fichiers.

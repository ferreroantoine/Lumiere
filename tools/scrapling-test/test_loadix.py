"""Test isolé : Scrapling passe-t-il la vérification de loadix.fun jusqu'aux liens 1fichier ?

Ouvre la recherche de loadix dans un navigateur maquillé (StealthySession, défis Cloudflare
résolus), suit le premier résultat (/media/…) et cherche les liens 1fichier de la page.
Chaque page visitée est enregistrée dans « sortie/ » pour comprendre un échec.

Mode d'emploi : voir README.md à côté de ce fichier.
"""

import argparse
import json
import re
import socket
import ssl
import sys
from pathlib import Path
from urllib.parse import quote, urljoin, urlparse
from urllib.request import Request, urlopen

SITE = "loadix.fun"

# Mêmes domaines que Lumière (apps/web/src/features/onefichier/links.ts).
DOMAINES_1FICHIER = [
    "1fichier.com",
    "alterupload.com",
    "cjoint.net",
    "desfichiers.com",
    "dfichiers.com",
    "megadl.fr",
    "mesfichiers.org",
    "piecejointe.net",
    "pjointe.com",
    "tenvoi.com",
]
LIEN_1FICHIER = re.compile(
    r"https?://(?:[a-z0-9-]+\.)*(?:"
    + "|".join(re.escape(domaine) for domaine in DOMAINES_1FICHIER)
    + r")/\?[a-z0-9]{5,20}[^\s\"'<>]*",
    re.IGNORECASE,
)

# Indices d'une page de vérification restée affichée (Cloudflare ou autre).
SIGNES_DE_BLOCAGE = {
    "Just a moment": "page d'attente Cloudflare",
    "challenges.cloudflare.com": "défi Cloudflare",
    "cf-turnstile": "Cloudflare Turnstile",
    "cf_chl_": "défi Cloudflare",
    "hcaptcha.com": "hCaptcha",
    "g-recaptcha": "reCAPTCHA",
    "datadome": "DataDome",
}

SORTIE = Path(__file__).resolve().with_name("sortie")


def adresse_systeme(hote: str) -> str | None:
    try:
        return socket.gethostbyname(hote)
    except OSError:
        return None


def adresse_doh(hote: str) -> str | None:
    """Adresse IPv4 donnée par le DNS chiffré de Cloudflare (insensible au DNS de la box)."""
    requete = Request(
        f"https://cloudflare-dns.com/dns-query?name={hote}&type=A",
        headers={"Accept": "application/dns-json"},
    )
    try:
        # Certificats de certifi : Windows n'installe certaines racines (SSL.com…) qu'à la demande,
        # et Python ne les trouve pas dans le magasin du système.
        import certifi

        contexte = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        contexte = ssl.create_default_context()
    try:
        with urlopen(requete, timeout=10, context=contexte) as reponse:
            reponses = json.load(reponse).get("Answer", [])
    except OSError as erreur:
        print(f"[!] DNS de Cloudflare injoignable : {erreur}")
        return None
    adresses = [entree["data"] for entree in reponses if entree.get("type") == 1]
    return adresses[0] if adresses else None


def regles_dns(hote: str) -> list[str]:
    """Option Chromium qui impose la bonne adresse si le DNS du système bloque le site."""
    systeme = adresse_systeme(hote)
    doh = adresse_doh(hote)
    print(f"Adresse de {hote} : DNS du système = {systeme or 'aucune'}, DNS de Cloudflare = {doh or 'aucune'}")
    if not doh or systeme == doh:
        return []
    if systeme in (None, "127.0.0.1", "0.0.0.0"):
        print("    Le DNS du système bloque le site : le navigateur utilisera l'adresse de Cloudflare.")
    return [f"--host-resolver-rules=MAP {hote} {doh}, MAP *.{hote} {doh}"]


def ouvrir(session, url: str):
    """Charge la page, ou None (avec l'erreur) si le navigateur n'a pas pu l'atteindre."""
    try:
        return session.fetch(url)
    except Exception as erreur:  # erreurs du navigateur (connexion, délai dépassé…)
        print(f"\nÉCHEC : la page n'a pas pu être chargée.\n{str(erreur).splitlines()[0]}")
        return None


def titre_section(texte: str) -> None:
    print(f"\n=== {texte} ===")


def analyser(page, nom: str) -> list[str]:
    """Affiche l'état de la page, l'enregistre et renvoie ses liens (adresses absolues)."""
    html = str(page.html_content)
    fichier = SORTIE / f"{nom}.html"
    fichier.write_text(html, encoding="utf-8")

    titre = page.css("title::text").get() or "(sans titre)"
    print(f"Statut HTTP : {page.status}")
    print(f"Adresse finale : {page.url}")
    print(f"Titre : {titre.strip()}")
    print(f"HTML enregistré : {fichier} ({len(html)} caractères)")

    blocages = sorted({libelle for signe, libelle in SIGNES_DE_BLOCAGE.items() if signe.lower() in html.lower()})
    if blocages:
        print(f"[!] Traces de vérification encore présentes : {', '.join(blocages)}")

    liens = []
    for href in page.css("a::attr(href)").getall():
        href = str(href).strip()
        if href and not href.startswith(("javascript:", "#", "mailto:")):
            liens.append(urljoin(str(page.url), href))
    return list(dict.fromkeys(liens))


def chercher_1fichier(page, liens: list[str]) -> list[str]:
    """Liens 1fichier dans les <a href> puis dans tout le HTML (attributs data-…, scripts)."""
    trouves = [lien for lien in liens if LIEN_1FICHIER.match(lien)]
    trouves += LIEN_1FICHIER.findall(str(page.html_content))
    return list(dict.fromkeys(trouves))


def decrire_page_sans_lien(page, liens: list[str]) -> None:
    """Ce qu'il y a sur la page, pour voir où se cachent les liens (bouton, autre site…)."""
    domaine_du_site = urlparse(str(page.url)).netloc
    externes: dict[str, int] = {}
    for lien in liens:
        domaine = urlparse(lien).netloc
        if domaine and domaine != domaine_du_site:
            externes[domaine] = externes.get(domaine, 0) + 1
    if externes:
        print("Liens vers d'autres sites :")
        for domaine, nombre in sorted(externes.items(), key=lambda item: -item[1]):
            print(f"  - {domaine} ({nombre})")

    boutons = [str(texte).strip() for texte in page.css("button::text, a.btn::text, [role=button]::text").getall()]
    boutons = [texte for texte in dict.fromkeys(boutons) if texte]
    if boutons:
        print("Boutons visibles : " + " | ".join(boutons[:20]))


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--titre", default="Dune", help="titre cherché sur loadix (défaut : Dune)")
    parser.add_argument("--type", choices=["movie", "series"], default="movie", help="film ou série")
    parser.add_argument("--rang", type=int, default=1, help="résultat de recherche à ouvrir (1 = le premier)")
    parser.add_argument("--page", help="ouvrir directement cette page loadix (ex. https://loadix.fun/media/123)")
    parser.add_argument("--visible", action="store_true", help="montrer la fenêtre du navigateur")
    parser.add_argument("--chrome", action="store_true", help="utiliser le Chrome installé plutôt que Chromium")
    parser.add_argument("--delai", type=int, default=60, help="délai maximal par page, en secondes (défaut : 60)")
    args = parser.parse_args()
    SORTIE.mkdir(exist_ok=True)

    try:
        from scrapling.fetchers import StealthySession
    except ImportError:
        print('Scrapling n\'est pas installé : voir README.md (pip install "scrapling[fetchers]").')
        return 2

    titre_section("Réseau")
    with StealthySession(
        headless=not args.visible,
        real_chrome=args.chrome,
        solve_cloudflare=True,
        network_idle=True,
        timeout=args.delai * 1000,
        extra_flags=regles_dns(SITE),
    ) as session:
        if args.page:
            page_media = args.page
        else:
            recherche = f"https://{SITE}/search?q={quote(args.titre)}&type={args.type}"
            titre_section(f"Recherche : {recherche}")
            page = ouvrir(session, recherche)
            if page is None:
                return 1
            liens = analyser(page, "1-recherche")
            medias = [lien for lien in liens if "/media/" in urlparse(lien).path]
            print(f"Résultats (/media/…) : {len(medias)}")
            for numero, lien in enumerate(medias[:10], start=1):
                print(f"  {numero}. {lien}")
            if len(medias) < args.rang:
                print("\nÉCHEC : aucun résultat à ouvrir. Regardez sortie/1-recherche.html "
                      "(page de vérification ? autre forme d'adresse que /media/ ?).")
                return 1
            page_media = medias[args.rang - 1]

        titre_section(f"Page du titre : {page_media}")
        page = ouvrir(session, page_media)
        if page is None:
            return 1
        liens = analyser(page, "2-titre")
        liens_1fichier = chercher_1fichier(page, liens)

        titre_section("Résultat")
        if liens_1fichier:
            print(f"RÉUSSITE : {len(liens_1fichier)} lien(s) 1fichier trouvé(s) :")
            for lien in liens_1fichier:
                print(f"  - {lien}")
            return 0

        print("Aucun lien 1fichier sur la page du titre.")
        decrire_page_sans_lien(page, liens)
        print("Envoyez-moi cette sortie et sortie/2-titre.html : les liens sont peut-être derrière "
              "un bouton ou un site de redirection.")
        return 1


if __name__ == "__main__":
    sys.exit(main())

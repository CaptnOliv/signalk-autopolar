#!/usr/bin/env python3
"""Fabrique toutes les tailles d'icônes à partir d'une seule image source.

    python3 tool/make-icons.py chemin/vers/source.png

Cinq fichiers sortent :

    public/icon.png             96x96   liste des webapps SignalK (signalk.appIcon)
    public/icon-192.png        192x192  manifest.json
    public/icon-512.png        512x512  manifest.json
    public/apple-touch-icon.png 180x180 écran d'accueil iOS
    icon.png                    96x96   copie de courtoisie à la racine du paquet

Le piège qui a coûté une itération : SignalK monte `public/` sous
/<nom-du-paquet>/ et résout `signalk.appIcon` comme une URL sous ce point de
montage. Une icône posée seulement à la racine du paquet renvoie 404, et rien
ne s'en plaint — l'icône est simplement absente de la liste.

Deux traitements, pour deux raisons distinctes :

  — RECADRAGE. Un export d'illustration laisse volontiers une marge
    transparente, et rarement la même de chaque côté. Telle quelle, l'icône
    s'affiche décentrée et plus petite que ses voisines. On recadre donc sur
    les pixels opaques, puis on ré-étend en carré autour de ce centre : jamais
    de déformation, jamais de marge parasite.

  — TRANSPARENCE. Elle est conservée partout sauf pour iOS, qui ignore le
    canal alpha, compose sur du noir, puis applique son propre masque arrondi.
    Sur cette seule image on aplatit donc sur un fond très sombre, que le
    masque d'iOS recoupe ensuite sans que rien ne se voie.
"""
import sys
import os
from PIL import Image

IOS_BACKDROP = (4, 8, 20)  # sous le masque arrondi d'iOS, invisible

SIZES = [
    ("public/icon.png", 96, True),
    ("public/icon-192.png", 192, True),
    ("public/icon-512.png", 512, True),
    ("public/apple-touch-icon.png", 180, False),
    ("icon.png", 96, True),
]


def square_on_content(im):
    """Recadre sur les pixels opaques, puis ré-étend en carré autour de leur
    centre — sans jamais sortir de l'image ni changer les proportions."""
    if im.mode != "RGBA":
        return im.convert("RGBA")
    box = im.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
    if not box:
        return im
    l, t, r, b = box
    side = max(r - l, b - t)
    cx, cy = (l + r) // 2, (t + b) // 2
    half = side // 2
    # Recentrer si le carré déborde, plutôt que de le rogner : mieux vaut
    # décaler de quelques pixels que rendre l'icône non carrée.
    x = min(max(cx - half, 0), max(im.width - side, 0))
    y = min(max(cy - half, 0), max(im.height - side, 0))
    side = min(side, im.width, im.height)
    print(f"source {im.width}x{im.height} · contenu {r - l}x{b - t} · recadré {side}x{side} en ({x},{y})")
    return im.crop((x, y, x + side, y + side))


def main(src):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    im = square_on_content(Image.open(src).convert("RGBA"))

    for rel, size, keep_alpha in SIZES:
        out = os.path.join(root, rel)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        small = im.resize((size, size), Image.LANCZOS)
        if not keep_alpha:
            flat = Image.new("RGB", small.size, IOS_BACKDROP)
            flat.paste(small, (0, 0), small)
            small = flat
        small.save(out, optimize=True)
        print(f"{rel:32} {size}x{size}  {'alpha' if keep_alpha else 'opaque':6} {os.path.getsize(out) // 1024} ko")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])

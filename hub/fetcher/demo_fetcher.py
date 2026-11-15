"""Fake job generator for testing the pipeline end-to-end (FETCHER=demo)."""
from __future__ import annotations

import random
import time

from .base import JobFetcher, JobIn

_SAMPLES = [
    ("Landing page en WordPress para clínica dental",
     "Necesitamos una landing page en WordPress con Elementor, formulario de contacto y "
     "integración con WhatsApp. Debe ser responsive y cargar rápido.",
     "USD 100 - 250", "IT & Programming", ["WordPress", "Elementor", "CSS"]),
    ("Script en Python para extraer datos de una API",
     "Busco un desarrollador Python que cree un script que consuma una API REST, guarde los "
     "datos en PostgreSQL y genere un reporte diario en Excel.",
     "USD 250 - 500", "IT & Programming", ["Python", "PostgreSQL", "API"]),
    ("Logo e identidade visual para cafeteria",
     "Preciso de um logotipo moderno e paleta de cores para uma cafeteria artesanal. "
     "Entregar arquivos vetoriais e manual básico de marca.",
     "Menos de USD 50", "Design & Multimedia", ["Logo design", "Illustrator", "Branding"]),
    ("React dashboard for logistics startup",
     "We need a React + TypeScript dashboard showing shipments on a map with filters and "
     "charts. Backend API already exists (REST).",
     "USD 500 - 1.000", "IT & Programming", ["React", "TypeScript", "Charts"]),
    ("Traducción de documentos técnicos inglés-español",
     "Traducción de 20 páginas de manuales técnicos de maquinaria industrial del inglés al español.",
     "USD 50 - 100", "Translation & Content", ["Translation", "English", "Spanish"]),
]


class DemoFetcher(JobFetcher):
    def __init__(self, probability: float = 0.5) -> None:
        self.probability = probability

    async def fetch_new(self) -> list[JobIn]:
        if random.random() > self.probability:
            return []
        title, desc, budget, cat, skills = random.choice(_SAMPLES)
        jid = f"demo-{int(time.time() * 1000)}"
        return [JobIn(
            id=jid, url=f"https://www.workana.com/job/{jid}", title=title, description=desc,
            budget_text=budget, category=cat, skills=skills,
            client_info={"country": random.choice(["Argentina", "Brasil", "México", "España"]),
                         "rating": round(random.uniform(3.5, 5), 1), "hires": random.randint(0, 40)},
        )]

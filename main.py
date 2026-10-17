from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles

from config import STATIC_DIR
from monitors import scheduler
from routers import system


@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.init_caches()
    scheduler.start_background_threads()
    yield
    # shutdown: background threads are daemons, nothing to clean up


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    response = await call_next(request)
    # Revalidate static assets AND the HTML shell (root + *.html). ETag/Last-
    # Modified still make unchanged files a cheap 304, but a new deploy is
    # picked up on a normal refresh — no hard-reload needed.
    path = request.url.path
    if path.startswith("/static") or path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.include_router(system.router)


@app.get("/", response_class=HTMLResponse)
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(str(STATIC_DIR / "favicon.svg"), media_type="image/svg+xml")

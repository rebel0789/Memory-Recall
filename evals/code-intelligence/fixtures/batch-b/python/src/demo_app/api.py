from django.urls import path
from demo_app.service import Service
from fastapi import FastAPI


app = FastAPI()


@app.get("/items/{item_id}")
def read_item(item_id):
    service = Service()
    return service.run()


def legacy_item(request, item_id):
    return item_id


urlpatterns = [path("/legacy/<int:item_id>", legacy_item)]

mod service;

use crate::service::Service;

fn item() {}

#[get("/rocket/<item_id>")]
fn rocket_item(item_id: u64) {}

fn router() {
    Router::new().route("/items/{item_id}", get(item));
}

fn actix_item() {}

fn app() {
    App::new().route("/legacy/{item_id}", web::post().to(actix_item));
}

fn build() -> Service {
    Service::new()
}

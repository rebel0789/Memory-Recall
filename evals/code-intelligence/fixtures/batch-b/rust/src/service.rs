pub trait Runner {
    fn run(&self) -> &'static str;
}

pub struct Service;

impl Service {
    pub fn new() -> Self {
        Self
    }
}

impl Runner for Service {
    fn run(&self) -> &'static str {
        "service"
    }
}

pub fn use_service(service: &Service) -> &'static str {
    service.run()
}

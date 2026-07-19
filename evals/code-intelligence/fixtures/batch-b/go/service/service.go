package service

type Runner interface {
	Run() string
}

type Service struct{}

func (s *Service) Run() string {
	return "service"
}

func Use(service *Service) string {
	return service.Run()
}
